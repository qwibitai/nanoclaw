import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force single-process mode BEFORE importing container-runner so
// `killContainer` (and through it, `killActiveSessionsForAgent`) takes
// the SIGTERM path on the fake `ChildProcess` instead of shelling out
// to `docker stop`. We re-export everything else from the real module
// so spawn paths and mode-dependent helpers stay correct.
//
// (Note: `vi.mock` is hoisted by Vitest so this takes effect before
// the static imports below resolve, regardless of physical line order.)
vi.mock('./container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runtime.js')>('./container-runtime.js');
  return {
    ...actual,
    isSingleProcessMode: () => true,
  };
});

import {
  __addActiveContainerForTest,
  isContainerRunning,
  killActiveSessionsForAgent,
  resolveAssistantName,
  resolveProviderName,
  wakeContainer,
} from './container-runner.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import type { Session } from './types.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('resolveAssistantName', () => {
  it('uses the agent group name for standard agents', () => {
    expect(resolveAssistantName({ name: 'Andy', company_id: null })).toBe('Andy');
  });

  it('omits assistantName for Baget founder groups', () => {
    expect(resolveAssistantName({ name: 'Acme', company_id: 'company-1' })).toBeUndefined();
  });
});

// ─── killActiveSessionsForAgent ───────────────────────────────────────
//
// Covers the in-flight-runner half of the disconnect bug: when a founder
// clicks Disconnect, any Bun child that was already mid-turn (because
// the founder sent a message seconds earlier) must be SIGTERM'd.
// Without this, the child finishes its turn and posts a stale reply to
// a now-disconnected channel.
describe('killActiveSessionsForAgent', () => {
  /**
   * Build a stand-in `ChildProcess` whose `.kill` is a vitest spy. Only
   * the fields the production code path reads in single-process mode
   * (`process.kill`) are populated — everything else is cast through
   * `unknown` so we don't drag in the rest of the Node `ChildProcess`
   * surface.
   */
  function fakeChildProcess(): ChildProcess {
    return { kill: vi.fn() } as unknown as ChildProcess;
  }

  it('SIGTERMs only the runners whose agent_group_id matches', () => {
    const matchA = fakeChildProcess();
    const matchB = fakeChildProcess();
    const other = fakeChildProcess();
    const cleanups = [
      __addActiveContainerForTest('sess-a-1', {
        process: matchA,
        containerName: 'fake-runner-a-1',
        agentGroupId: 'ag-target',
      }),
      __addActiveContainerForTest('sess-a-2', {
        process: matchB,
        containerName: 'fake-runner-a-2',
        agentGroupId: 'ag-target',
      }),
      __addActiveContainerForTest('sess-other', {
        process: other,
        containerName: 'fake-runner-other',
        agentGroupId: 'ag-untouched',
      }),
    ];

    try {
      const killed = killActiveSessionsForAgent('ag-target', 'unit test — disconnect');

      expect(killed).toBe(2);
      expect(matchA.kill).toHaveBeenCalledTimes(1);
      expect(matchA.kill).toHaveBeenCalledWith('SIGTERM');
      expect(matchB.kill).toHaveBeenCalledTimes(1);
      expect(matchB.kill).toHaveBeenCalledWith('SIGTERM');
      // The unrelated agent_group's runner MUST be left alone — that's
      // a different founder's session.
      expect(other.kill).not.toHaveBeenCalled();
    } finally {
      for (const c of cleanups) c();
    }
  });

  it('returns 0 and calls nothing when no runners match', () => {
    const proc = fakeChildProcess();
    const cleanup = __addActiveContainerForTest('sess-x', {
      process: proc,
      containerName: 'fake-runner-x',
      agentGroupId: 'ag-other',
    });

    try {
      const killed = killActiveSessionsForAgent('ag-not-running', 'unit test — empty match');
      expect(killed).toBe(0);
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('returns 0 when the activeContainers map is empty (no runners at all)', () => {
    expect(killActiveSessionsForAgent('ag-anything', 'unit test — empty map')).toBe(0);
  });
});

// ─── spawnContainer archive gate (regression test for the sweep race) ──
//
// Indirectly exercised through `wakeContainer`. The bug we're guarding
// against: after the founder clicks Disconnect, `archiveBagetAgentGroup`
// stamps `archived_at`, but `getActiveSessions()` (used by the host
// sweep) only filters on `sessions.status = 'active'`. With a pending
// inbound message, the sweep would call `wakeContainer(session)` for an
// archived agent_group and silently re-spawn — re-introducing the very
// stale-reply bug `killActiveSessionsForAgent` was added to fix.
describe('spawnContainer / wakeContainer — archive gate', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('does not register a runner when the agent_group is archived', async () => {
    // Seed an archived agent_group + a still-active session row. This
    // mirrors what state SQLite is in immediately after a disconnect:
    // the session row hasn't been transitioned to 'closed' (the
    // disconnect path leaves history intact), but the agent_group has
    // been stamped.
    getDb()
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ag-archived', 'Acme', 'baget-archived', '2026-01-01T00:00:00Z', 'u-1', 'c-1', '2026-05-01T00:00:00Z');

    const session: Session = {
      id: 'sess-archived-1',
      agent_group_id: 'ag-archived',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-04-30T00:00:00Z',
    };

    await wakeContainer(session);

    // The gate's contract: nothing in `activeContainers` for this
    // session id. We don't assert wakeContainer's return value because
    // its `.then(() => true)` resolves true regardless of whether
    // spawnContainer actually spawned — the gate is a silent skip.
    expect(isContainerRunning(session.id)).toBe(false);
  });
});
