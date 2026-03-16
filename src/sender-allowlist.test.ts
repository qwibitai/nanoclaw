import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAutoTriggerSender,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
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

  it('skips invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toBeUndefined();
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

  it('filters non-string entries from autoTriggerSenders', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      autoTriggerSenders: ['valid', 123, null, 'also-valid'],
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.autoTriggerSenders).toEqual(['valid', 'also-valid']);
  });
});
