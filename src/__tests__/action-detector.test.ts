import { describe, it, expect } from 'vitest';
import { detectActions } from '../action-detector.js';
import type { MessageMeta } from '../types.js';

function makeMeta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    category: 'email',
    urgency: 'info',
    actions: [],
    batchable: false,
    ...overrides,
  };
}

describe('detectActions', () => {
  describe('forward detection', () => {
    it('detects "forward to email" pattern', () => {
      const text =
        'FloppyData sent a sign-in link. Want me to forward it to philip.ye@whoisxmlapi.com?';
      const meta = makeMeta({ threadId: 'thread123', account: 'personal' });
      const actions = detectActions(text, meta);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('forward');
      expect(actions[0].recipient).toBe('philip.ye@whoisxmlapi.com');
      expect(actions[0].actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: expect.stringContaining('Forward'),
            callbackData: expect.stringContaining('forward:'),
          }),
        ]),
      );
    });

    it('extracts recipient from "forward this to user@example.com"', () => {
      const text = 'I can forward this to alice@example.org for you.';
      const meta = makeMeta({ threadId: 't1', account: 'dev' });
      const actions = detectActions(text, meta);
      expect(actions).toHaveLength(1);
      expect(actions[0].recipient).toBe('alice@example.org');
    });

    it('does not detect forward without email address', () => {
      const text = 'Want me to forward this to Philip?';
      const meta = makeMeta({ threadId: 't1' });
      const actions = detectActions(text, meta);
      expect(actions.filter((a) => a.type === 'forward')).toHaveLength(0);
    });

    it('skips forward when no threadId in meta', () => {
      const text = 'Forward to test@example.com?';
      const meta = makeMeta(); // no threadId
      const actions = detectActions(text, meta);
      expect(actions.filter((a) => a.type === 'forward')).toHaveLength(0);
    });
  });

  describe('RSVP detection', () => {
    it('detects RSVP suggestion', () => {
      const text =
        'SMSF Donor Recognition Party on May 3. Do you want to attend? I can RSVP for you.';
      const meta = makeMeta();
      const actions = detectActions(text, meta);
      const rsvp = actions.find((a) => a.type === 'rsvp');
      expect(rsvp).toBeDefined();
      expect(rsvp!.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '✅ RSVP Yes' }),
          expect.objectContaining({ label: '❌ Decline' }),
        ]),
      );
    });

    it('detects "want to attend" pattern', () => {
      const text = 'Would you like to attend the team dinner?';
      const meta = makeMeta();
      const actions = detectActions(text, meta);
      expect(actions.find((a) => a.type === 'rsvp')).toBeDefined();
    });
  });

  describe('open URL detection', () => {
    it('detects magic link pattern', () => {
      const text =
        'FloppyData sent a magic sign-in link. Should I click it directly?';
      const meta = makeMeta();
      const actions = detectActions(text, meta);
      const openUrl = actions.find((a) => a.type === 'open_url');
      expect(openUrl).toBeDefined();
      expect(openUrl!.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '🔗 Open Link' }),
        ]),
      );
    });

    it('detects "open this link" pattern', () => {
      const text = 'Want me to open this link for you?';
      const meta = makeMeta();
      const actions = detectActions(text, meta);
      expect(actions.find((a) => a.type === 'open_url')).toBeDefined();
    });
  });

  describe('multiple actions', () => {
    it('can detect forward and open URL in same text', () => {
      const text =
        'I can forward this to philip@test.com or click the link directly.';
      const meta = makeMeta({ threadId: 't1', account: 'personal' });
      const actions = detectActions(text, meta);
      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions.find((a) => a.type === 'forward')).toBeDefined();
      expect(actions.find((a) => a.type === 'open_url')).toBeDefined();
    });
  });

  describe('no actions', () => {
    it('returns empty array for plain text', () => {
      const text = 'Here is your daily summary.';
      const meta = makeMeta();
      const actions = detectActions(text, meta);
      expect(actions).toHaveLength(0);
    });
  });
});
