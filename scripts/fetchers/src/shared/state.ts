import fs from 'fs';
import path from 'path';

/**
 * Read fetch state from a JSON file. Returns empty object if missing/invalid.
 */
export function readState<T>(statePath: string): T {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch {
    // Corrupted state — start fresh
  }
  return {} as T;
}

/**
 * Write fetch state atomically (write .tmp then rename).
 */
export function writeState(statePath: string, state: object): void {
  const tmpPath = statePath + '.tmp';
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}
