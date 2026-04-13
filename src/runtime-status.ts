import { writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface ChannelHeartbeat {
  connected: boolean;
  connectedAt?: string;
  disconnectedAt?: string;
  lastEvent?: string;
  metadata?: Record<string, string | number>;
}

export interface RuntimeStatus {
  writtenAt: string;
  processStartedAt: string;
  channels: Record<string, ChannelHeartbeat>;
}

const STATUS_FILE = path.join(DATA_DIR, 'runtime-status.json');

const state: RuntimeStatus = {
  writtenAt: new Date(0).toISOString(),
  processStartedAt: new Date().toISOString(),
  channels: {},
};

function flush(): void {
  state.writtenAt = new Date().toISOString();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATUS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATUS_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to write runtime-status.json');
  }
}

export function initRuntimeStatus(): void {
  state.processStartedAt = new Date().toISOString();
  state.channels = {};
  flush();
}

export function markConnected(
  name: string,
  metadata?: Record<string, string | number>,
): void {
  const now = new Date().toISOString();
  const existing = state.channels[name] || { connected: false };
  state.channels[name] = {
    ...existing,
    connected: true,
    connectedAt: now,
    lastEvent: now,
    metadata: metadata ?? existing.metadata,
  };
  flush();
}

export function markDisconnected(name: string): void {
  const now = new Date().toISOString();
  const existing = state.channels[name] || { connected: false };
  state.channels[name] = {
    ...existing,
    connected: false,
    disconnectedAt: now,
  };
  flush();
}

export function markEvent(name: string): void {
  const existing = state.channels[name];
  if (!existing) return;
  existing.lastEvent = new Date().toISOString();
  flush();
}
