/**
 * Host-side Ollama startup health check.
 * Pings HOST_OLLAMA_ENDPOINT/api/tags and writes data/.host-ollama-status.json.
 * Non-blocking — memory feature is optional. Never throws.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface HostOllamaStatus {
  ok: boolean;
  checkedAt: string;
  endpoint: string;
  error?: string;
}

const RAW_ENDPOINT = process.env.HOST_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const TAGS_URL = `${RAW_ENDPOINT.replace(/\/$/, '')}/api/tags`;
const DEFAULT_STATUS_PATH = path.join(DATA_DIR, '.host-ollama-status.json');
const STARTUP_TIMEOUT_MS = 1000;

let _statusFilePathOverride: string | null = null;

export function setStatusFilePathForTest(p: string | null): void {
  _statusFilePathOverride = p;
}

function getStatusFilePath(): string {
  return _statusFilePathOverride ?? DEFAULT_STATUS_PATH;
}

function writeStatusFile(status: HostOllamaStatus): void {
  const filePath = getStatusFilePath();
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    log.warn('host-ollama-status: failed to write status file', { filePath, err });
    // Clean up tmp if rename failed.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Ping Ollama and write data/.host-ollama-status.json.
 * Returns the status object. Never throws.
 */
export async function runStartupOllamaCheck(): Promise<HostOllamaStatus> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STARTUP_TIMEOUT_MS);

  let status: HostOllamaStatus;
  try {
    const resp = await fetch(TAGS_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      status = { ok: true, checkedAt, endpoint: RAW_ENDPOINT };
      log.info('host-ollama-status: Ollama reachable', { endpoint: RAW_ENDPOINT });
    } else {
      status = { ok: false, checkedAt, endpoint: RAW_ENDPOINT, error: `HTTP ${resp.status}` };
      log.warn('host-ollama-status: Ollama returned non-OK status', { status: resp.status });
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    status = { ok: false, checkedAt, endpoint: RAW_ENDPOINT, error: msg };
    log.warn('host-ollama-status: Ollama unreachable', { endpoint: RAW_ENDPOINT, err: msg });
  }

  writeStatusFile(status);
  return status;
}
