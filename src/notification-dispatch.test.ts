import { describe, expect, it, vi } from 'vitest';

import type {
  AdminEntry,
  NotificationTarget,
  PriorityLevel,
} from './escalation.js';
import {
  dispatchEscalationNotifications,
  formatNotificationMessage,
} from './notification-dispatch.js';
import type {
  EscalationNotification,
  NotificationDeps,
} from './notification-dispatch.js';

function makeNotification(
  overrides: Partial<EscalationNotification> = {},
): EscalationNotification {
  return {
    caseName: '260318-1400-test-case',
    caseId: 'case-123',
    description: 'Missing pricing data for brochure order',
    gapType: 'information_expected',
    gapDescription: 'Missing business data',
    priority: 'high',
    score: 5,
    sourceGroup: 'telegram_garsson',
    ...overrides,
  };
}

function makeAdmin(overrides: Partial<AdminEntry> = {}): AdminEntry {
  return {
    name: 'Alice',
    role: 'technical',
    email: 'alice@example.com',
    telegram: 'tg:111',
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<NotificationTarget> = {},
): NotificationTarget {
  return {
    admin: makeAdmin(),
    channels: ['telegram'],
    role: 'primary',
    ...overrides,
  };
}

function makeDeps(): NotificationDeps & {
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// INVARIANT: Notification messages contain all essential escalation info
// SUT: formatNotificationMessage
describe('formatNotificationMessage', () => {
  it('includes priority, gap type, case description, and role', () => {
    const notification = makeNotification();
    const target = makeTarget();

    const message = formatNotificationMessage(notification, target);

    expect(message).toContain('HIGH');
    expect(message).toContain('information_expected');
    expect(message).toContain('Missing pricing data');
    expect(message).toContain('Primary');
    expect(message).toContain('technical');
    expect(message).toContain('telegram_garsson');
  });

  it('includes gap description when available', () => {
    const notification = makeNotification({
      gapDescription: 'Missing business data',
    });
    const target = makeTarget();

    const message = formatNotificationMessage(notification, target);

    expect(message).toContain('Missing business data');
  });

  it('truncates long context to 300 chars', () => {
    const longContext = 'A'.repeat(500);
    const notification = makeNotification({ context: longContext });
    const target = makeTarget();

    const message = formatNotificationMessage(notification, target);

    expect(message).toContain('A'.repeat(300));
    expect(message).toContain('…');
    expect(message).not.toContain('A'.repeat(301));
  });

  it('includes short context without truncation', () => {
    const notification = makeNotification({ context: 'Short context' });
    const target = makeTarget();

    const message = formatNotificationMessage(notification, target);

    expect(message).toContain('Short context');
    expect(message).not.toContain('…');
  });

  it('shows CC role for cc targets', () => {
    const notification = makeNotification();
    const target = makeTarget({ role: 'cc' });

    const message = formatNotificationMessage(notification, target);

    expect(message).toContain('CC');
  });

  it('uses correct priority emoji', () => {
    const priorities: [PriorityLevel, string][] = [
      ['critical', '🔴'],
      ['high', '🟠'],
      ['normal', '🟡'],
      ['low', '⚪'],
    ];

    for (const [priority, emoji] of priorities) {
      const notification = makeNotification({ priority });
      const target = makeTarget();
      const message = formatNotificationMessage(notification, target);
      expect(message).toContain(emoji);
    }
  });
});

// INVARIANT: Notifications are dispatched to all targets with correct channels
// SUT: dispatchEscalationNotifications
describe('dispatchEscalationNotifications', () => {
  it('sends telegram notifications via deps.sendMessage', async () => {
    const deps = makeDeps();
    const notification = makeNotification();
    const targets = [makeTarget({ channels: ['telegram'] })];

    const sent = await dispatchEscalationNotifications(
      notification,
      targets,
      deps,
    );

    expect(sent).toBe(1);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('information_expected'),
    );
  });

  it('sends to multiple targets', async () => {
    const deps = makeDeps();
    const notification = makeNotification();
    const targets = [
      makeTarget({
        admin: makeAdmin({ name: 'Alice', telegram: 'tg:111' }),
        channels: ['telegram'],
      }),
      makeTarget({
        admin: makeAdmin({ name: 'Bob', telegram: 'tg:222' }),
        channels: ['telegram'],
        role: 'cc',
      }),
    ];

    const sent = await dispatchEscalationNotifications(
      notification,
      targets,
      deps,
    );

    expect(sent).toBe(2);
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('returns 0 for empty targets', async () => {
    const deps = makeDeps();
    const notification = makeNotification();

    const sent = await dispatchEscalationNotifications(notification, [], deps);

    expect(sent).toBe(0);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('skips telegram notification when admin has no telegram JID', async () => {
    const deps = makeDeps();
    const notification = makeNotification();
    const targets = [
      makeTarget({
        admin: makeAdmin({ telegram: undefined }),
        channels: ['telegram'],
      }),
    ];

    const sent = await dispatchEscalationNotifications(
      notification,
      targets,
      deps,
    );

    expect(sent).toBe(0);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('continues dispatching when one target fails', async () => {
    const deps = makeDeps();
    deps.sendMessage
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(undefined);

    const notification = makeNotification();
    const targets = [
      makeTarget({
        admin: makeAdmin({ name: 'Alice', telegram: 'tg:111' }),
        channels: ['telegram'],
      }),
      makeTarget({
        admin: makeAdmin({ name: 'Bob', telegram: 'tg:222' }),
        channels: ['telegram'],
        role: 'cc',
      }),
    ];

    const sent = await dispatchEscalationNotifications(
      notification,
      targets,
      deps,
    );

    // First fails, second succeeds
    expect(sent).toBe(1);
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('logs but does not send for email channel (not yet implemented)', async () => {
    const deps = makeDeps();
    const notification = makeNotification();
    const targets = [makeTarget({ channels: ['email'] })];

    const sent = await dispatchEscalationNotifications(
      notification,
      targets,
      deps,
    );

    expect(sent).toBe(0);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
