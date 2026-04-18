import { describe, it, expect, vi } from 'vitest';
import { CalendarOpsRouter } from '../calendar-ops.js';

describe('CalendarOpsRouter', () => {
  it('calls rsvp on registered provider', async () => {
    const router = new CalendarOpsRouter();
    const provider = {
      rsvp: vi.fn().mockResolvedValue(undefined),
    };
    router.register('personal', provider);
    await router.rsvp('personal', 'event123', 'accepted');
    expect(provider.rsvp).toHaveBeenCalledWith('event123', 'accepted');
  });

  it('throws for unknown account', async () => {
    const router = new CalendarOpsRouter();
    await expect(router.rsvp('unknown', 'event1', 'accepted')).rejects.toThrow(
      'No calendar provider registered for account: unknown',
    );
  });

  it('routes declined response', async () => {
    const router = new CalendarOpsRouter();
    const provider = {
      rsvp: vi.fn().mockResolvedValue(undefined),
    };
    router.register('personal', provider);
    await router.rsvp('personal', 'event456', 'declined');
    expect(provider.rsvp).toHaveBeenCalledWith('event456', 'declined');
  });
});
