/**
 * Verifies that the host sweep tick calls into the backup scheduler.
 * The scheduler's own throttle decisions are covered separately by
 * `decideShouldBackup` tests; here we just want proof the wire exists.
 */
import { describe, expect, it, vi } from 'vitest';

const maybeRunDailyBackup = vi.fn().mockResolvedValue(undefined);

vi.mock('./scheduler.js', () => ({
  maybeRunDailyBackup,
  decideShouldBackup: vi.fn(),
}));

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('../db/sessions.js')>('../db/sessions.js');
  return { ...actual, getActiveSessions: vi.fn().mockReturnValue([]) };
});

describe('host-sweep / backup wiring', () => {
  it('invokes maybeRunDailyBackup at the top of each sweep tick', async () => {
    const sweepModule = await import('../host-sweep.js');
    sweepModule.startHostSweep();
    // sweep() is async fire-and-forget; let it process.
    await new Promise((r) => setTimeout(r, 30));
    sweepModule.stopHostSweep();

    expect(maybeRunDailyBackup).toHaveBeenCalled();
  });
});
