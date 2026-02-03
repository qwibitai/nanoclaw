import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function distPath(relativeFile) {
  return path.join(projectRoot, 'dist', relativeFile);
}

export function importFresh(modulePath) {
  const url = pathToFileURL(modulePath).href;
  const cacheBust = `t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(`${url}?${cacheBust}`);
}

export async function withTempCwd(tempDir, fn) {
  const cwd = process.cwd();
  process.chdir(tempDir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
  }
}
