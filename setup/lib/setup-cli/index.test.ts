import { describe, it, expect } from 'vitest';

import { claudeCli, codexCli, getSetupCli, listSetupClis } from './index.js';

describe('setup-cli registry', () => {
  it('lists at least claude and codex', () => {
    const names = listSetupClis().map((a) => a.name);
    expect(names).toContain('claude');
    expect(names).toContain('codex');
  });

  it('getSetupCli returns the matching adapter', () => {
    expect(getSetupCli('claude')).toBe(claudeCli);
    expect(getSetupCli('codex')).toBe(codexCli);
  });

  it('getSetupCli is case-insensitive', () => {
    expect(getSetupCli('CLAUDE')).toBe(claudeCli);
    expect(getSetupCli('Codex')).toBe(codexCli);
  });

  it('getSetupCli returns undefined for unknown / null', () => {
    expect(getSetupCli('mystery-cli')).toBeUndefined();
    expect(getSetupCli(null)).toBeUndefined();
    expect(getSetupCli(undefined)).toBeUndefined();
  });
});

describe('claude adapter shape', () => {
  it('headless returns print-mode argv (tools off by default)', () => {
    const spawn = claudeCli.headless('what is 2+2');
    expect(spawn.args).toEqual(['-p', '--output-format', 'text', 'what is 2+2']);
    expect(spawn.stdin).toBe('ignore');
    expect(spawn.output).toBe('pipe');
  });

  it('headless with tools=true adds bypassPermissions for the assist flow', () => {
    const spawn = claudeCli.headless('diagnose this', { tools: true });
    expect(spawn.args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      'diagnose this',
    ]);
  });

  it('handoff returns interactive argv', () => {
    const spawn = claudeCli.handoff('debug this failure');
    expect(spawn.args).toEqual(['debug this failure']);
    expect(spawn.stdin).toBe('inherit');
    expect(spawn.output).toBe('inherit');
  });

  it('declares its install script', () => {
    expect(claudeCli.installScript).toBe('setup/install-claude.sh');
  });
});

describe('codex adapter shape', () => {
  it('headless uses `exec` subcommand', () => {
    const spawn = codexCli.headless('what is 2+2');
    expect(spawn.args).toEqual(['exec', 'what is 2+2']);
    expect(spawn.stdin).toBe('ignore');
    expect(spawn.output).toBe('pipe');
  });

  it('headless tools opt is a no-op (exec already allows tool use)', () => {
    const spawn = codexCli.headless('diagnose this', { tools: true });
    expect(spawn.args).toEqual(['exec', 'diagnose this']);
  });

  it('handoff is bare invocation with prompt as argv', () => {
    const spawn = codexCli.handoff('debug this failure');
    expect(spawn.args).toEqual(['debug this failure']);
    expect(spawn.stdin).toBe('inherit');
    expect(spawn.output).toBe('inherit');
  });

  it('declares no scriptable install (fork installs via /add-codex skill)', () => {
    expect(codexCli.installScript).toBeNull();
  });

  it('isAuthenticated returns undefined when installed (no fast offline probe)', () => {
    if (codexCli.isInstalled()) {
      expect(codexCli.isAuthenticated()).toBeUndefined();
    } else {
      expect(codexCli.isAuthenticated()).toBe(false);
    }
  });
});
