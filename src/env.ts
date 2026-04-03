import fs from 'fs';
import os from 'os';
import path from 'path';

// Cache parsed .env contents keyed by mtime to avoid redundant disk reads.
// Invalidated when file mtime changes or after MAX_CACHE_AGE_MS.
const MAX_CACHE_AGE_MS = 60_000;
let envCache: { content: string; mtimeMs: number; cachedAt: number } | null = null;

function readEnvContent(envFile: string): string | null {
  try {
    const stat = fs.statSync(envFile);
    const now = Date.now();
    if (
      envCache &&
      envCache.mtimeMs === stat.mtimeMs &&
      now - envCache.cachedAt < MAX_CACHE_AGE_MS
    ) {
      return envCache.content;
    }
    const content = fs.readFileSync(envFile, 'utf-8');
    envCache = { content, mtimeMs: stat.mtimeMs, cachedAt: now };
    return content;
  } catch {
    return null;
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Uses mtime-based caching to avoid redundant disk reads on frequent calls
 * (e.g. container spawns reading secrets). Cache auto-invalidates when the
 * file changes or after 60s.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  const content = readEnvContent(envFile);
  if (!content) return {};

  // Warn if .env is group-readable or world-readable (Linux/macOS only)
  if (os.platform() !== 'win32') {
    try {
      const stat = fs.statSync(envFile);
      if (stat.mode & 0o044) {
        console.warn(
          `WARNING: .env file is readable by group/others (mode ${(stat.mode & 0o777).toString(8)}). ` +
            `Run "chmod 600 .env" to restrict access.`,
        );
      }
    } catch {
      /* stat failed, skip check */
    }
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
