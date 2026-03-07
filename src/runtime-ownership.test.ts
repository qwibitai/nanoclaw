import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getRuntimeOwner } from './db.js';
import {
  RuntimeOwnershipConflictError,
  claimRuntimeOwnership,
  heartbeatRuntimeOwnership,
  isOwnedByCurrentProcess,
  isRuntimeOwnerStale,
  releaseRuntimeOwnership,
} from './runtime-ownership.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('runtime ownership', () => {
  it('claims ownership when no owner exists', () => {
    const now = new Date().toISOString();
    const result = claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      startedAt: now,
      heartbeatAt: now,
      authScope: '/tmp/auth',
      launchdLabel: 'com.nanoclaw',
      claimedBy: 'test-service',
      isPidAlive: () => true,
    });

    expect(result.action).toBe('claimed');
    expect(getRuntimeOwner('host')?.pid).toBe(101);
  });

  it('rejects a second healthy owner without explicit takeover', () => {
    const now = new Date().toISOString();
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      heartbeatAt: now,
      startedAt: now,
      claimedBy: 'service-owner',
      isPidAlive: () => true,
    });

    expect(() =>
      claimRuntimeOwnership({
        pid: 202,
        ownerMode: 'manual',
        startedAt: new Date(Date.now() + 1_000).toISOString(),
        heartbeatAt: new Date(Date.now() + 1_000).toISOString(),
        claimedBy: 'manual-owner',
        isPidAlive: () => true,
      }),
    ).toThrow(RuntimeOwnershipConflictError);
  });

  it('allows explicit takeover of an active owner', () => {
    const now = new Date().toISOString();
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      heartbeatAt: now,
      startedAt: now,
      claimedBy: 'service-owner',
      isPidAlive: () => true,
    });

    const result = claimRuntimeOwnership({
      pid: 202,
      ownerMode: 'manual',
      allowTakeover: true,
      startedAt: new Date(Date.now() + 2_000).toISOString(),
      heartbeatAt: new Date(Date.now() + 2_000).toISOString(),
      claimedBy: 'manual-owner',
      isPidAlive: () => true,
    });

    expect(result.action).toBe('taken_over');
    expect(getRuntimeOwner('host')?.pid).toBe(202);
  });

  it('reclaims a stale owner', () => {
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      heartbeatAt: '2026-03-06T00:00:00.000Z',
      startedAt: '2026-03-06T00:00:00.000Z',
      claimedBy: 'service-owner',
      isPidAlive: () => false,
    });

    const result = claimRuntimeOwnership({
      pid: 202,
      ownerMode: 'service',
      startedAt: '2026-03-06T00:00:10.000Z',
      heartbeatAt: '2026-03-06T00:00:10.000Z',
      claimedBy: 'replacement-owner',
      isPidAlive: () => false,
    });

    expect(result.action).toBe('reclaimed');
    expect(getRuntimeOwner('host')?.pid).toBe(202);
  });

  it('heartbeats only when the current process still owns the record', () => {
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      heartbeatAt: '2026-03-06T00:00:00.000Z',
      startedAt: '2026-03-06T00:00:00.000Z',
      claimedBy: 'service-owner',
      isPidAlive: () => true,
    });

    expect(heartbeatRuntimeOwnership({ pid: 101 }).ok).toBe(true);
    expect(heartbeatRuntimeOwnership({ pid: 202 }).ok).toBe(false);
  });

  it('releases ownership only for the owning pid', () => {
    claimRuntimeOwnership({
      pid: 101,
      ownerMode: 'service',
      heartbeatAt: '2026-03-06T00:00:00.000Z',
      startedAt: '2026-03-06T00:00:00.000Z',
      claimedBy: 'service-owner',
      isPidAlive: () => true,
    });

    expect(releaseRuntimeOwnership({ pid: 202 })).toBe(false);
    expect(releaseRuntimeOwnership({ pid: 101 })).toBe(true);
    expect(getRuntimeOwner('host')).toBeUndefined();
  });

  it('marks dead owners as stale', () => {
    const owner = {
      owner_name: 'host',
      owner_mode: 'service' as const,
      pid: 999,
      started_at: '2026-03-06T00:00:00.000Z',
      heartbeat_at: '2026-03-06T00:00:00.000Z',
      auth_scope: '/tmp/auth',
      launchd_label: 'com.nanoclaw',
      claimed_by: 'service-owner',
    };

    expect(
      isRuntimeOwnerStale(owner, {
        isPidAlive: () => false,
        staleMs: 999999999,
      }),
    ).toBe(true);
    expect(isOwnedByCurrentProcess(owner, 999)).toBe(true);
  });
});
