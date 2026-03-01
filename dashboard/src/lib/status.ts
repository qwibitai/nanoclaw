import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const STATUS_PATH = path.join(PROJECT_ROOT, 'data', 'status.json');

export interface RuntimeStatus {
  uptime: number;
  startedAt: string;
  timestamp: string;
  channels: Array<{ name: string; connected: boolean }>;
  queue: {
    activeCount: number;
    maxConcurrent: number;
    waitingCount: number;
    groups: Record<
      string,
      {
        active: boolean;
        idleWaiting: boolean;
        isTaskContainer: boolean;
        pendingMessages: boolean;
        pendingTaskCount: number;
        containerName: string | null;
      }
    >;
  };
  groups: Record<string, { name: string; folder: string }>;
  lastTimestamp: string;
}

export function readStatus(): RuntimeStatus | null {
  try {
    const raw = fs.readFileSync(STATUS_PATH, 'utf-8');
    return JSON.parse(raw) as RuntimeStatus;
  } catch {
    return null;
  }
}
