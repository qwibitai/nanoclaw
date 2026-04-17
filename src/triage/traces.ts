import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

let traceDir =
  process.env.TRIAGE_TRACE_DIR ??
  path.resolve(process.cwd(), '.omc/logs/triage');

export function setTraceDir(d: string): void {
  traceDir = d;
}

export function getTraceDir(): string {
  return traceDir;
}

export interface TraceRecord {
  trackedItemId: string;
  tier: 1 | 2 | 3;
  latencyMs: number;
  queue: string;
  confidence: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  shadowMode?: boolean;
  error?: string;
}

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(traceDir, `${date}.jsonl`);
}

export function emitTrace(r: TraceRecord): void {
  try {
    fs.mkdirSync(traceDir, { recursive: true });
    const line = JSON.stringify({ ...r, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(todayFile(), line);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to write triage trace');
  }
}
