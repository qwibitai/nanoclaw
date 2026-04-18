import { describe, it, expect } from 'vitest';

describe('ChatInterfaceConfig defaults', () => {
  it('exports CHAT_INTERFACE_CONFIG with correct defaults', async () => {
    const { CHAT_INTERFACE_CONFIG } = await import('../config.js');

    expect(CHAT_INTERFACE_CONFIG).toEqual({
      morningDashboardTime: '07:30',
      digestThreshold: 5,
      digestMinIntervalMs: 7200000,
      staleAfterDigestCycles: 2,
      pushRateLimit: 3,
      pushRateWindowMs: 1800000,
      vipList: [],
      urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
      holdPushDuringMeetings: true,
      microBriefingDelayMs: 60000,
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        weekendMode: true,
        escalateOverride: true,
      },
    });
  });
});
