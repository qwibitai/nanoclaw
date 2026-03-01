import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const IPC_DIR = path.join(PROJECT_ROOT, 'data', 'ipc', 'main', 'tasks');

export function writeIpcCommand(data: Record<string, unknown>): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const filename = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = path.join(IPC_DIR, filename);
  const tmpPath = `${filepath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, filepath);
}
