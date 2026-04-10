import fs from 'fs';
import path from 'path';

import { DATA_DIR, DEFAULT_TRIGGER } from './config.js';
import { GroupQueueSnapshot } from './group-queue.js';

export type RuntimeLifecycleStatus =
  | 'starting'
  | 'running'
  | 'shutting_down'
  | 'stopped'
  | 'error';

export interface RuntimeChannelStatus {
  name: string;
  connected: boolean;
}

export interface RuntimeDashboardState {
  role: 'agent';
  pid: number;
  status: RuntimeLifecycleStatus;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  defaultTrigger: string;
  channels: RuntimeChannelStatus[];
  queue: GroupQueueSnapshot;
}

type RuntimeDashboardUpdate = Partial<
  Omit<RuntimeDashboardState, 'role' | 'pid' | 'startedAt' | 'defaultTrigger'>
>;

const DASHBOARD_DIR = path.join(DATA_DIR, 'dashboard');
export const DASHBOARD_RUNTIME_FILE = path.join(
  DASHBOARD_DIR,
  'runtime-status.json',
);
export const DASHBOARD_EVENTS_FILE = path.join(DASHBOARD_DIR, 'events.jsonl');

let runtimeState: RuntimeDashboardState | null = null;

function ensureDashboardDir(): void {
  fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDashboardDir();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

export function initRuntimeDashboardState(): void {
  const now = new Date().toISOString();
  runtimeState = {
    role: 'agent',
    pid: process.pid,
    status: 'starting',
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    defaultTrigger: DEFAULT_TRIGGER,
    channels: [],
    queue: {
      activeCount: 0,
      waitingGroups: [],
      groups: {},
    },
  };
  writeJsonAtomic(DASHBOARD_RUNTIME_FILE, runtimeState);
}

export function updateRuntimeDashboardState(
  update: RuntimeDashboardUpdate,
): void {
  if (!runtimeState) initRuntimeDashboardState();
  const now = new Date().toISOString();
  runtimeState = {
    ...(runtimeState as RuntimeDashboardState),
    ...update,
    updatedAt: now,
    heartbeatAt: update.heartbeatAt ?? now,
  };
  writeJsonAtomic(DASHBOARD_RUNTIME_FILE, runtimeState);
}

export function markRuntimeDashboardStopped(
  status: Extract<RuntimeLifecycleStatus, 'stopped' | 'error'> = 'stopped',
): void {
  updateRuntimeDashboardState({ status });
}
