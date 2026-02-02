import fs from 'fs';
import path from 'path';

export function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Return default on error
  }
  return defaultValue;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function isSafeGroupFolder(folder: string, groupsDir: string): boolean {
  if (!folder || !/^[a-z0-9-]+$/.test(folder)) return false;
  const base = path.resolve(groupsDir);
  const resolved = path.resolve(base, folder);
  return resolved.startsWith(base + path.sep);
}
