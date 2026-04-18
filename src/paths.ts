/**
 * Project root resolution.
 *
 * Derives the project root from the source file location (`import.meta.url`)
 * rather than `process.cwd()`. This is reliable regardless of the working
 * directory the process was started from (e.g., systemd, cron, wrapper
 * scripts).
 *
 * Every module that needs project-relative paths should import PROJECT_ROOT
 * from here instead of calling process.cwd().
 */
import { fileURLToPath } from 'node:url';
import path from 'path';

export function resolveProjectRoot(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  // src/paths.ts -> project root is one level up from src/
  return path.resolve(path.dirname(modulePath), '..');
}

export const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
