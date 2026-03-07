import os from 'os';
import path from 'path';

import {
  RUNTIME_OWNER_ALLOW_TAKEOVER,
  RUNTIME_OWNER_HEARTBEAT_MS,
  RUNTIME_OWNER_LAUNCHD_LABEL,
  RUNTIME_OWNER_MODE,
  RUNTIME_OWNER_NAME,
  RUNTIME_OWNER_STALE_MS,
  STORE_DIR,
} from './config.js';
import {
  deleteRuntimeOwner,
  getRuntimeOwner,
  updateRuntimeOwnerHeartbeat,
  upsertRuntimeOwner,
} from './db.js';
import { logger } from './logger.js';
import type { RuntimeOwnerMode, RuntimeOwnerRecord } from './types.js';

export interface RuntimeOwnershipOptions {
  ownerName?: string;
  ownerMode?: RuntimeOwnerMode;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  authScope?: string;
  launchdLabel?: string | null;
  claimedBy?: string;
  allowTakeover?: boolean;
  staleMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

export interface RuntimeOwnershipClaimResult {
  action: 'claimed' | 'already_owned' | 'reclaimed' | 'taken_over';
  record: RuntimeOwnerRecord;
  previousOwner?: RuntimeOwnerRecord;
}

export interface RuntimeOwnershipHeartbeatResult {
  ok: boolean;
  currentOwner?: RuntimeOwnerRecord;
}

export class RuntimeOwnershipConflictError extends Error {
  readonly currentOwner: RuntimeOwnerRecord;

  constructor(message: string, currentOwner: RuntimeOwnerRecord) {
    super(message);
    this.name = 'RuntimeOwnershipConflictError';
    this.currentOwner = currentOwner;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultClaimedBy(pid: number): string {
  const entry = process.argv[1] || 'unknown-entry';
  return `${os.hostname()}:${pid}:${path.basename(entry)}`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

export function isRuntimeOwnerStale(
  owner: RuntimeOwnerRecord,
  options: Pick<RuntimeOwnershipOptions, 'staleMs' | 'isPidAlive'> = {},
): boolean {
  const staleMs = options.staleMs ?? RUNTIME_OWNER_STALE_MS;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const heartbeatAtMs = Date.parse(owner.heartbeat_at);
  const heartbeatExpired =
    Number.isFinite(heartbeatAtMs) && Date.now() - heartbeatAtMs > staleMs;
  return heartbeatExpired || !isPidAlive(owner.pid);
}

export function isOwnedByCurrentProcess(
  owner: RuntimeOwnerRecord | undefined,
  pid = process.pid,
): boolean {
  return Boolean(owner && owner.pid === pid);
}

function buildOwnerRecord(
  options: RuntimeOwnershipOptions = {},
): RuntimeOwnerRecord {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? nowIso();
  const heartbeatAt = options.heartbeatAt ?? startedAt;

  return {
    owner_name: options.ownerName ?? RUNTIME_OWNER_NAME,
    owner_mode: options.ownerMode ?? RUNTIME_OWNER_MODE,
    pid,
    started_at: startedAt,
    heartbeat_at: heartbeatAt,
    auth_scope: options.authScope ?? path.join(STORE_DIR, 'auth'),
    launchd_label:
      options.launchdLabel === undefined
        ? RUNTIME_OWNER_LAUNCHD_LABEL
        : options.launchdLabel,
    claimed_by: options.claimedBy ?? defaultClaimedBy(pid),
  };
}

export function claimRuntimeOwnership(
  options: RuntimeOwnershipOptions = {},
): RuntimeOwnershipClaimResult {
  const desired = buildOwnerRecord(options);
  const current = getRuntimeOwner(desired.owner_name);
  const allowTakeover = options.allowTakeover ?? RUNTIME_OWNER_ALLOW_TAKEOVER;

  if (!current) {
    upsertRuntimeOwner(desired);
    return { action: 'claimed', record: desired };
  }

  if (current.pid === desired.pid) {
    const refreshed = {
      ...desired,
      started_at: current.started_at || desired.started_at,
      heartbeat_at: desired.heartbeat_at,
    };
    upsertRuntimeOwner(refreshed);
    return {
      action: 'already_owned',
      record: refreshed,
      previousOwner: current,
    };
  }

  const stale = isRuntimeOwnerStale(current, options);
  if (!stale && !allowTakeover) {
    throw new RuntimeOwnershipConflictError(
      `Runtime owner already active (${current.owner_mode} pid=${current.pid})`,
      current,
    );
  }

  upsertRuntimeOwner(desired);
  return {
    action: stale ? 'reclaimed' : 'taken_over',
    record: desired,
    previousOwner: current,
  };
}

export function heartbeatRuntimeOwnership(
  options: Pick<RuntimeOwnershipOptions, 'ownerName' | 'pid'> = {},
): RuntimeOwnershipHeartbeatResult {
  const ownerName = options.ownerName ?? RUNTIME_OWNER_NAME;
  const pid = options.pid ?? process.pid;
  const current = getRuntimeOwner(ownerName);
  if (!current || current.pid !== pid) {
    return { ok: false, currentOwner: current };
  }

  const ok = updateRuntimeOwnerHeartbeat(ownerName, pid, nowIso());
  return { ok, currentOwner: current };
}

export function releaseRuntimeOwnership(
  options: Pick<RuntimeOwnershipOptions, 'ownerName' | 'pid'> = {},
): boolean {
  const ownerName = options.ownerName ?? RUNTIME_OWNER_NAME;
  const pid = options.pid ?? process.pid;
  return deleteRuntimeOwner(ownerName, pid);
}

export function getCurrentRuntimeOwner(
  ownerName = RUNTIME_OWNER_NAME,
): RuntimeOwnerRecord | undefined {
  return getRuntimeOwner(ownerName);
}

export function logRuntimeOwnershipClaim(
  result: RuntimeOwnershipClaimResult,
): void {
  logger.info(
    {
      ownerMode: result.record.owner_mode,
      pid: result.record.pid,
      action: result.action,
      previousOwnerPid: result.previousOwner?.pid,
      previousOwnerMode: result.previousOwner?.owner_mode,
      heartbeatMs: RUNTIME_OWNER_HEARTBEAT_MS,
      staleMs: RUNTIME_OWNER_STALE_MS,
    },
    'Runtime ownership established',
  );
}
