import { describe, expect, it } from 'vitest';

import { buildTriggerPattern, getTriggerPattern } from './config.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildTriggerPattern', () => {
  const pattern = buildTriggerPattern('@Andy');

  it('matches @name at start of message', () => {
    expect(pattern.test('@Andy hello')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(pattern.test('@andy hello')).toBe(true);
    expect(pattern.test('@ANDY hello')).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(pattern.test('hello @Andy')).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(pattern.test('@Andyextra hello')).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(pattern.test("@Andy's thing")).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(pattern.test('@Andy')).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    expect(pattern.test('@Andy hey'.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test('@Andy hello')).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern).toBeInstanceOf(RegExp);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
  });
});

// Replicates the exact gating logic from processGroupMessages +
// startMessageLoop: `!isMainGroup && requiresTrigger !== false` decides
// whether the trigger pattern is consulted at all.
describe('trigger gating (requiresTrigger interaction)', () => {
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, undefined, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: '@TestBot do something' })];
    expect(shouldProcess(false, true, '@TestBot', msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only a different trigger is present', () => {
    const msgs = [makeMsg({ content: '@Other do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});
