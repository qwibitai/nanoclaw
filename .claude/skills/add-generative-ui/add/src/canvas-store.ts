import fs from 'fs';
import path from 'path';

import pkg from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';

import { DATA_DIR } from './config.js';

const { applyPatch } = pkg;

const SPECSTREAM_OPS = new Set<Operation['op']>([
  'add',
  'remove',
  'replace',
  'move',
  'copy',
  'test',
]);

interface JsonRenderSpec {
  root: string | null;
  elements: Record<string, unknown>;
}

function createEmptySpec(): JsonRenderSpec {
  return {
    root: null,
    elements: {},
  };
}

function coerceSpec(input: unknown): JsonRenderSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return createEmptySpec();
  }

  const value = input as Record<string, unknown>;
  const root =
    typeof value.root === 'string' || value.root === null ? value.root : null;
  const elements =
    value.elements && typeof value.elements === 'object' && !Array.isArray(value.elements)
      ? (value.elements as Record<string, unknown>)
      : {};

  return {
    root,
    elements,
  };
}

export interface CanvasState {
  groupFolder: string;
  spec: unknown;
  revision: number;
  updatedAt: string | null;
}

export type CanvasSpecStreamEvent = Operation;

interface StoredCanvasState {
  spec: unknown;
  revision: number;
  updatedAt: string | null;
}

export class CanvasEventError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'CanvasEventError';
    this.line = line;
  }
}

export class CanvasStore {
  private readonly canvasDir: string;
  private readonly cache = new Map<string, StoredCanvasState>();

  constructor(canvasDir = path.join(DATA_DIR, 'canvas')) {
    this.canvasDir = canvasDir;
    fs.mkdirSync(this.canvasDir, { recursive: true });
  }

  getState(groupFolder: string): CanvasState {
    const state = this.getOrLoad(groupFolder);
    return {
      groupFolder,
      spec: structuredClone(state.spec),
      revision: state.revision,
      updatedAt: state.updatedAt,
    };
  }

  applyEventsFromJsonl(groupFolder: string, eventsJsonl: string): CanvasState {
    const operations = parseCanvasEventsJsonl(eventsJsonl);
    return this.applyEvents(groupFolder, operations);
  }

  applyEvents(groupFolder: string, operations: CanvasSpecStreamEvent[]): CanvasState {
    if (operations.length === 0) {
      throw new CanvasEventError('No canvas events found in request body', 0);
    }

    const current = this.getOrLoad(groupFolder);
    let nextSpec = coerceSpec(structuredClone(current.spec));

    operations.forEach((operation, index) => {
      const line = index + 1;
      try {
        const patchResult = applyPatch(
          nextSpec as Record<string, unknown>,
          [operation],
          true,
          false,
        );
        nextSpec = coerceSpec(patchResult.newDocument);
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        throw new CanvasEventError(
          `Invalid SpecStream operation: ${details}`,
          line,
        );
      }
    });

    const updated: StoredCanvasState = {
      spec: nextSpec,
      revision: current.revision + operations.length,
      updatedAt: new Date().toISOString(),
    };

    this.persist(groupFolder, updated);

    return {
      groupFolder,
      spec: structuredClone(updated.spec),
      revision: updated.revision,
      updatedAt: updated.updatedAt,
    };
  }

  private getOrLoad(groupFolder: string): StoredCanvasState {
    const cached = this.cache.get(groupFolder);
    if (cached) return cached;

    const filePath = this.getCanvasFilePath(groupFolder);
    if (!fs.existsSync(filePath)) {
      const initial: StoredCanvasState = {
        spec: createEmptySpec(),
        revision: 0,
        updatedAt: null,
      };
      this.cache.set(groupFolder, initial);
      return initial;
    }

    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as StoredCanvasState;
      const loaded: StoredCanvasState = {
        spec: coerceSpec(parsed.spec),
        revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
        updatedAt: parsed.updatedAt ?? null,
      };
      this.cache.set(groupFolder, loaded);
      return loaded;
    } catch {
      const fallback: StoredCanvasState = {
        spec: createEmptySpec(),
        revision: 0,
        updatedAt: null,
      };
      this.cache.set(groupFolder, fallback);
      return fallback;
    }
  }

  private persist(groupFolder: string, state: StoredCanvasState): void {
    const filePath = this.getCanvasFilePath(groupFolder);
    const tempPath = `${filePath}.tmp`;

    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    this.cache.set(groupFolder, state);
  }

  private getCanvasFilePath(groupFolder: string): string {
    return path.join(this.canvasDir, `${groupFolder}.json`);
  }
}

export function parseCanvasEventsJsonl(input: string): CanvasSpecStreamEvent[] {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, idx) => {
    const lineNumber = idx + 1;
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CanvasEventError('Invalid JSON on line', lineNumber);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CanvasEventError('Canvas event must be an object', lineNumber);
    }

    const event = parsed as Record<string, unknown>;
    const op = event.op;

    if (typeof op !== 'string' || !SPECSTREAM_OPS.has(op as Operation['op'])) {
      throw new CanvasEventError(
        'SpecStream event "op" must be one of add/remove/replace/move/copy/test',
        lineNumber,
      );
    }

    if (typeof event.path !== 'string') {
      throw new CanvasEventError('SpecStream event requires string "path"', lineNumber);
    }

    if ((op === 'add' || op === 'replace' || op === 'test') && !('value' in event)) {
      throw new CanvasEventError(
        `SpecStream "${op}" event requires "value"`,
        lineNumber,
      );
    }

    if ((op === 'move' || op === 'copy') && typeof event.from !== 'string') {
      throw new CanvasEventError(
        `SpecStream "${op}" event requires string "from"`,
        lineNumber,
      );
    }

    return event as Operation;
  });
}
