import fs from 'fs';
import path from 'path';

import pkg from 'fast-json-patch';
const { applyPatch } = pkg;
import type { Operation } from 'fast-json-patch';

import { DATA_DIR } from '../../../../src/config.js';

export interface CanvasState {
  groupFolder: string;
  spec: unknown;
  revision: number;
  updatedAt: string | null;
}

export type CanvasEvent =
  | {
      type: 'set';
      spec: unknown;
    }
  | {
      type: 'patch';
      ops: Operation[];
    };

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
    const events = parseCanvasEventsJsonl(eventsJsonl);
    if (events.length === 0) {
      throw new CanvasEventError('No canvas events found in request body', 0);
    }

    const current = this.getOrLoad(groupFolder);
    let nextSpec = structuredClone(current.spec);

    events.forEach((event, index) => {
      const line = index + 1;
      if (event.type === 'set') {
        nextSpec = structuredClone(event.spec);
        return;
      }

      try {
        const patchResult = applyPatch(
          nextSpec as Record<string, unknown>,
          event.ops,
          true,
          false,
        );
        nextSpec = patchResult.newDocument;
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        throw new CanvasEventError(`Invalid patch operation: ${details}`, line);
      }
    });

    const updated: StoredCanvasState = {
      spec: nextSpec,
      revision: current.revision + events.length,
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
        spec: {},
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
        spec: parsed.spec ?? {},
        revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
        updatedAt: parsed.updatedAt ?? null,
      };
      this.cache.set(groupFolder, loaded);
      return loaded;
    } catch {
      const fallback: StoredCanvasState = {
        spec: {},
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

export function parseCanvasEventsJsonl(input: string): CanvasEvent[] {
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

    if (!parsed || typeof parsed !== 'object') {
      throw new CanvasEventError('Canvas event must be an object', lineNumber);
    }

    const event = parsed as Record<string, unknown>;

    if (event.type === 'set') {
      if (!('spec' in event)) {
        throw new CanvasEventError('"set" event requires "spec"', lineNumber);
      }
      return {
        type: 'set',
        spec: event.spec,
      };
    }

    if (event.type === 'patch') {
      if (!Array.isArray(event.ops)) {
        throw new CanvasEventError(
          '"patch" event requires "ops" array',
          lineNumber,
        );
      }
      return {
        type: 'patch',
        ops: event.ops as Operation[],
      };
    }

    throw new CanvasEventError(
      'Canvas event type must be "set" or "patch"',
      lineNumber,
    );
  });
}
