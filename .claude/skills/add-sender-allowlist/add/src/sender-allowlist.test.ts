import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-allowlist-test-'));
  configPath = path.join(tmpDir, 'sender-allowlist.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(cfg: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when config file is missing', () => {
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
    expect(cfg.failMode).toBe('open');
  });

  it('loads allow=* correctly', () => {
    writeConfig({ default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: true, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.default.allow).toBe('*');
  });

  it('loads allow=[] (deny all) correctly', () => {
    writeConfig({ default: { allow: [], mode: 'drop' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.default.allow).toEqual([]);
    expect(cfg.default.mode).toBe('drop');
  });

  it('loads allow=[list] correctly', () => {
    writeConfig({ default: { allow: ['alice', 'bob'], mode: 'trigger' }, chats: {}, logDenied: true, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
  });

  it('per-chat override beats default', () => {
    writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group1@g.us': { allow: ['alice'], mode: 'drop' } },
      logDenied: true,
      failMode: 'open',
    });
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.chats['group1@g.us'].allow).toEqual(['alice']);
    expect(cfg.chats['group1@g.us'].mode).toBe('drop');
    expect(cfg.default.allow).toBe('*'); // default unchanged
  });

  it('invalid JSON with failMode=open returns allow-all and logs warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);

    fs.writeFileSync(configPath, '{ invalid json "failMode": "open" }');
    const cfg = loadSenderAllowlist(configPath);

    expect(cfg.default.allow).toBe('*');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: configPath }),
      expect.stringContaining('failMode=open'),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('invalid JSON with failMode=closed returns deny-all and logs error', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);

    fs.writeFileSync(configPath, '{ invalid json "failMode": "closed" }');
    const cfg = loadSenderAllowlist(configPath);

    expect(cfg.default.allow).toEqual([]);
    expect(cfg.default.mode).toBe('drop');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: configPath }),
      expect.stringContaining('failMode=closed'),
    );
  });

  it('invalid schema with failMode=closed returns deny-all', () => {
    writeConfig({
      default: { mode: 'drop' },
      chats: {},
      logDenied: true,
      failMode: 'closed',
    });
    const cfg = loadSenderAllowlist(configPath);
    expect(cfg.default.allow).toEqual([]);
    expect(cfg.default.mode).toBe('drop');
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    writeConfig({ default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('any@g.us', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    writeConfig({ default: { allow: [], mode: 'drop' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('any@g.us', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    writeConfig({ default: { allow: ['alice@s.whatsapp.net', 'bob@s.whatsapp.net'], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'alice@s.whatsapp.net', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'bob@s.whatsapp.net', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'carol@s.whatsapp.net', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'grp@g.us': { allow: ['alice'], mode: 'trigger' } },
      logDenied: false,
      failMode: 'open',
    });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('other@g.us', 'bob', cfg)).toBe(true); // default allows all
  });
});

describe('deny list', () => {
  it('deny blocks a sender even when allow=*', () => {
    writeConfig({ default: { allow: '*', deny: ['eve'], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'eve', cfg)).toBe(false);
  });

  it('deny blocks a sender even when they are in the allow list', () => {
    writeConfig({ default: { allow: ['alice', 'eve'], deny: ['eve'], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'eve', cfg)).toBe(false);
  });

  it('per-chat deny overrides default allow', () => {
    writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'grp@g.us': { allow: '*', deny: ['eve'], mode: 'trigger' } },
      logDenied: false,
      failMode: 'open',
    });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'eve', cfg)).toBe(false);
    expect(isSenderAllowed('grp@g.us', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('other@g.us', 'eve', cfg)).toBe(true); // default has no deny
  });

  it('deny with drop mode blocks message storage', () => {
    writeConfig({ default: { allow: '*', deny: ['eve'], mode: 'drop' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(shouldDropMessage('grp@g.us', cfg)).toBe(true);
    expect(isSenderAllowed('grp@g.us', 'eve', cfg)).toBe(false);
    expect(isSenderAllowed('grp@g.us', 'alice', cfg)).toBe(true);
  });

  it('no deny field means no deny list (allow-only behavior)', () => {
    writeConfig({ default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isSenderAllowed('grp@g.us', 'anyone', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for mode=trigger', () => {
    writeConfig({ default: { allow: [], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(shouldDropMessage('grp@g.us', cfg)).toBe(false);
  });

  it('returns true for mode=drop', () => {
    writeConfig({ default: { allow: [], mode: 'drop' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(shouldDropMessage('grp@g.us', cfg)).toBe(true);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    writeConfig({ default: { allow: ['alice'], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isTriggerAllowed('grp@g.us', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for denied sender in trigger mode and does not imply drop mode', () => {
    writeConfig({ default: { allow: ['alice'], mode: 'trigger' }, chats: {}, logDenied: false, failMode: 'open' });
    const cfg = loadSenderAllowlist(configPath);
    expect(isTriggerAllowed('grp@g.us', 'eve', cfg)).toBe(false);
    expect(shouldDropMessage('grp@g.us', cfg)).toBe(false);
  });

  it('allows trigger when allow=* (default config)', () => {
    const cfg = loadSenderAllowlist(configPath); // file missing = defaults
    expect(isTriggerAllowed('grp@g.us', 'anyone', cfg)).toBe(true);
  });
});
