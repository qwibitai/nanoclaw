import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAutoTriggerContent,
  isAutoTriggerSender,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldAutoTrigger,
  shouldDropMessage,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*'); // falls back to default
  });

  it('rejects config with invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    // Zod rejects the entire config when any chat entry is invalid
    expect(cfg.default.allow).toBe('*');
    expect(cfg.chats).toEqual({});
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
      autoTriggerSenders: [],
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
      autoTriggerSenders: [],
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('isAutoTriggerSender', () => {
  it('returns true for sender in autoTriggerSenders list', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: ['5697720897', '123456'],
    };
    expect(isAutoTriggerSender('5697720897', cfg)).toBe(true);
  });

  it('returns false for sender not in autoTriggerSenders list', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: ['5697720897'],
    };
    expect(isAutoTriggerSender('999999', cfg)).toBe(false);
  });

  it('returns false when autoTriggerSenders is empty', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
      autoTriggerSenders: [],
    };
    expect(isAutoTriggerSender('anyone', cfg)).toBe(false);
  });
});

describe('loadSenderAllowlist autoTriggerSenders', () => {
  it('defaults to empty array when not specified', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.autoTriggerSenders).toEqual([]);
  });

  it('loads autoTriggerSenders from config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      autoTriggerSenders: ['5697720897', '123456'],
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.autoTriggerSenders).toEqual(['5697720897', '123456']);
  });

  it('rejects config with non-string entries in autoTriggerSenders', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      autoTriggerSenders: ['valid', 123, null, 'also-valid'],
    });
    const cfg = loadSenderAllowlist(p);
    // Zod rejects the entire config when autoTriggerSenders contains non-strings
    expect(cfg.autoTriggerSenders).toEqual([]);
  });
});

// INVARIANT: Auto-trigger content filter must reject trivial acks and pass substantive messages.
// SUT: isAutoTriggerContent — pure function, no dependencies.
describe('isAutoTriggerContent', () => {
  it('rejects short messages below minimum length', () => {
    expect(isAutoTriggerContent('ok')).toBe(false);
    expect(isAutoTriggerContent('k')).toBe(false);
    expect(isAutoTriggerContent('')).toBe(false);
    expect(isAutoTriggerContent('  ')).toBe(false);
  });

  it('rejects common acknowledgment words', () => {
    expect(isAutoTriggerContent('thanks')).toBe(false);
    expect(isAutoTriggerContent('Thank you')).toBe(false);
    expect(isAutoTriggerContent('yep')).toBe(false);
    expect(isAutoTriggerContent('sure')).toBe(false);
    expect(isAutoTriggerContent('cool')).toBe(false);
    expect(isAutoTriggerContent('great')).toBe(false);
    expect(isAutoTriggerContent('got it')).toBe(false);
    expect(isAutoTriggerContent('noted')).toBe(false);
    expect(isAutoTriggerContent('sounds good')).toBe(false);
    expect(isAutoTriggerContent('will do')).toBe(false);
    expect(isAutoTriggerContent('done')).toBe(false);
  });

  it('rejects emoji-only acknowledgments', () => {
    expect(isAutoTriggerContent('👍')).toBe(false);
    expect(isAutoTriggerContent('👌')).toBe(false);
    expect(isAutoTriggerContent('🙏')).toBe(false);
    expect(isAutoTriggerContent('✅')).toBe(false);
    expect(isAutoTriggerContent('🔥')).toBe(false);
  });

  it('rejects ack patterns with surrounding whitespace', () => {
    expect(isAutoTriggerContent('  thanks  ')).toBe(false);
    expect(isAutoTriggerContent('\tok\n')).toBe(false);
  });

  it('is case-insensitive for ack patterns', () => {
    expect(isAutoTriggerContent('OK')).toBe(false);
    expect(isAutoTriggerContent('Thanks')).toBe(false);
    expect(isAutoTriggerContent('SURE')).toBe(false);
    expect(isAutoTriggerContent('YEP')).toBe(false);
  });

  it('accepts substantive messages', () => {
    expect(isAutoTriggerContent('Can you check the logs?')).toBe(true);
    expect(isAutoTriggerContent('What is the status of the deploy?')).toBe(
      true,
    );
    expect(isAutoTriggerContent('please update the config')).toBe(true);
    expect(isAutoTriggerContent('run npm test')).toBe(true);
  });

  it('accepts messages that contain ack words as part of larger text', () => {
    expect(isAutoTriggerContent('ok, can you also fix the tests?')).toBe(true);
    expect(isAutoTriggerContent('thanks for that, now deploy it')).toBe(true);
  });

  it('accepts exactly-min-length non-ack content', () => {
    expect(isAutoTriggerContent('hey')).toBe(true);
    expect(isAutoTriggerContent('fix')).toBe(true);
  });

  it('accepts multi-emoji messages not in ack list', () => {
    expect(isAutoTriggerContent('👍👍')).toBe(true);
    expect(isAutoTriggerContent('🎉🎊')).toBe(true);
  });
});

// INVARIANT: shouldAutoTrigger must require BOTH sender in auto-trigger list AND substantive content.
// SUT: shouldAutoTrigger — composes isAutoTriggerSender + isAutoTriggerContent.
describe('shouldAutoTrigger', () => {
  const cfg: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
    autoTriggerSenders: ['lead1', 'lead2'],
  };

  it('triggers for auto-trigger sender with substantive content', () => {
    expect(shouldAutoTrigger('lead1', 'Check the deployment logs', cfg)).toBe(
      true,
    );
  });

  it('does not trigger for auto-trigger sender with ack content', () => {
    expect(shouldAutoTrigger('lead1', 'ok', cfg)).toBe(false);
    expect(shouldAutoTrigger('lead2', 'thanks', cfg)).toBe(false);
    expect(shouldAutoTrigger('lead1', '👍', cfg)).toBe(false);
  });

  it('does not trigger for non-auto-trigger sender regardless of content', () => {
    expect(
      shouldAutoTrigger('random-user', 'Check the deployment logs', cfg),
    ).toBe(false);
  });

  it('does not trigger for non-auto-trigger sender with ack content', () => {
    expect(shouldAutoTrigger('random-user', 'ok', cfg)).toBe(false);
  });
});
