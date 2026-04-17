import { vi } from 'vitest';

import type { SchedulerDependencies } from './task-scheduler.js';

/** Resolve the hoisted `runHostAgent` mock lazily so callers can override it per-test. */
export async function getRunHostAgentMock(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('./host-runner.js');
  return mod.runHostAgent as ReturnType<typeof vi.fn>;
}

/**
 * Default SchedulerDependencies: one registered group `test-group` owning
 * JID `tg:999`, an in-memory `enqueueTask` that immediately runs the
 * callback, and a stub sendMessage. Override any field as needed.
 */
export function makeDeps(
  overrides?: Partial<SchedulerDependencies>,
): SchedulerDependencies {
  const groupFolder = 'test-group';
  const chatJid = 'tg:999';
  return {
    registeredGroups: () => ({
      [chatJid]: {
        name: 'test',
        folder: groupFolder,
        isMain: true,
        requiresTrigger: false,
        trigger: '',
        added_at: '',
      },
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(
        (_jid: string, _taskId: string, fn: () => Promise<void>) => {
          void fn();
        },
      ),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      killProcess: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    onProcess: () => {},
    sendMessage: vi.fn(async () => {}),
    ...overrides,
  };
}
