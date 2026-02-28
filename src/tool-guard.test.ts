import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  evaluateToolCall,
  loadToolGuardConfig,
  DEFAULT_CONFIG,
  ToolGuardConfig,
  ToolGuardConfigSchema,
} from './tool-guard.js';

// ── evaluateToolCall ─────────────────────────────────────────────────

describe('evaluateToolCall', () => {
  const config: ToolGuardConfig = {
    block: ['rm -rf', 'DROP TABLE', 'shutdown'],
    pause: ['send_sms', 'make_call', 'x402_fetch', 'delegate_task'],
    allow: ['recall', 'remember', 'send_message'],
  };

  // Block patterns
  it('blocks when args contain a block pattern', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'Run rm -rf /' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('block_pattern');
  });

  it('blocks case-insensitively', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'drop table users' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('block_pattern');
  });

  it('blocks when tool name itself matches a block pattern', () => {
    const v = evaluateToolCall('shutdown', {}, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('block_pattern');
  });

  it('block pattern takes priority over allow list', () => {
    const v = evaluateToolCall('recall', { query: 'rm -rf cleanup scripts' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('block_pattern');
  });

  it('catches block patterns in nested args', () => {
    const v = evaluateToolCall('delegate_task', {
      prompt: 'please help',
      config: { command: 'DROP TABLE users' },
    }, config);
    expect(v.action).toBe('block');
  });

  // Allow list
  it('allows tools in allow list', () => {
    const v = evaluateToolCall('recall', { query: 'meeting notes' }, config);
    expect(v.action).toBe('allow');
    expect(v.rule).toBe('allow_list');
  });

  it('allows send_message explicitly', () => {
    const v = evaluateToolCall('send_message', { text: 'hello' }, config);
    expect(v.action).toBe('allow');
    expect(v.rule).toBe('allow_list');
  });

  // Pause list
  it('blocks tools in pause list not in allow list', () => {
    const v = evaluateToolCall('send_sms', { to: '+1234567890', body: 'hi' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('pause_list');
  });

  it('blocks x402_fetch in pause list', () => {
    const v = evaluateToolCall('x402_fetch', { url: 'https://example.com' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('pause_list');
  });

  it('blocks delegate_task in pause list (clean args)', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'research TypeScript' }, config);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('pause_list');
  });

  // Default allow
  it('allows unlisted tools by default', () => {
    const v = evaluateToolCall('list_tasks', {}, config);
    expect(v.action).toBe('allow');
    expect(v.rule).toBe('default');
  });

  it('allows unknown tools by default', () => {
    const v = evaluateToolCall('new_fancy_tool', { x: 1 }, config);
    expect(v.action).toBe('allow');
    expect(v.rule).toBe('default');
  });

  // Empty config
  it('allows everything with empty config', () => {
    const empty: ToolGuardConfig = { block: [], pause: [], allow: [] };
    expect(evaluateToolCall('send_sms', {}, empty).action).toBe('allow');
    expect(evaluateToolCall('anything', {}, empty).action).toBe('allow');
  });

  // Whitespace evasion resistance
  it('catches double-space evasion: "rm  -rf"', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'rm  -rf /' }, config);
    expect(v.action).toBe('block');
  });

  it('catches tab evasion: "rm\\t-rf"', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'rm\t-rf /' }, config);
    expect(v.action).toBe('block');
  });

  it('catches newline evasion: "rm\\n-rf"', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'rm\n-rf /' }, config);
    expect(v.action).toBe('block');
  });

  it('catches multi-whitespace evasion: "DROP  \\t TABLE"', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'DROP  \t TABLE users' }, config);
    expect(v.action).toBe('block');
  });

  // Default config
  it('default config blocks dangerous patterns', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'run rm -rf /' }, DEFAULT_CONFIG);
    expect(v.action).toBe('block');
    expect(v.rule).toBe('block_pattern');
  });

  it('default config allows normal tool calls', () => {
    const v = evaluateToolCall('send_sms', { to: '+1234', body: 'hi' }, DEFAULT_CONFIG);
    expect(v.action).toBe('allow');
    expect(v.rule).toBe('default');
  });

  it('default config blocks DROP DATABASE', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'DROP DATABASE production' }, DEFAULT_CONFIG);
    expect(v.action).toBe('block');
  });

  it('default config blocks TRUNCATE TABLE', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'TRUNCATE TABLE logs' }, DEFAULT_CONFIG);
    expect(v.action).toBe('block');
  });

  // Reason strings
  it('includes pattern in block reason', () => {
    const v = evaluateToolCall('delegate_task', { prompt: 'rm -rf /tmp' }, config);
    expect(v.reason).toContain('rm -rf');
  });

  it('includes tool name in pause reason', () => {
    const v = evaluateToolCall('send_sms', { to: '+1' }, config);
    expect(v.reason).toContain('send_sms');
  });

  it('includes tool name in allow reason', () => {
    const v = evaluateToolCall('recall', { query: 'test' }, config);
    expect(v.reason).toContain('recall');
  });
});

// ── ToolGuardConfigSchema ────────────────────────────────────────────

describe('ToolGuardConfigSchema', () => {
  it('validates a full config', () => {
    const result = ToolGuardConfigSchema.parse({
      block: ['a', 'b'],
      pause: ['c'],
      allow: ['d'],
    });
    expect(result.block).toEqual(['a', 'b']);
    expect(result.pause).toEqual(['c']);
    expect(result.allow).toEqual(['d']);
  });

  it('applies defaults for missing fields', () => {
    const result = ToolGuardConfigSchema.parse({});
    expect(result.block).toEqual([]);
    expect(result.pause).toEqual([]);
    expect(result.allow).toEqual([]);
  });

  it('applies defaults for partial config', () => {
    const result = ToolGuardConfigSchema.parse({ block: ['x'] });
    expect(result.block).toEqual(['x']);
    expect(result.pause).toEqual([]);
    expect(result.allow).toEqual([]);
  });
});

// ── loadToolGuardConfig ──────────────────────────────────────────────

describe('loadToolGuardConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from group folder and merges with default block patterns', () => {
    const groupDir = path.join(tmpDir, 'mygroup');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'tool-guard.json'),
      JSON.stringify({ block: ['EVIL'], pause: ['send_sms'], allow: ['recall'] }),
    );

    const config = loadToolGuardConfig('mygroup', () => groupDir);
    // Group patterns merged WITH defaults — can't weaken defaults
    expect(config.block).toContain('EVIL');
    expect(config.block).toContain('rm -rf');
    expect(config.block).toContain('DROP TABLE');
    expect(config.pause).toEqual(['send_sms']);
    expect(config.allow).toEqual(['recall']);
  });

  it('falls back to global config when group config missing', () => {
    const baseDir = path.join(tmpDir, 'groups');
    const globalDir = path.join(baseDir, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'tool-guard.json'),
      JSON.stringify({ block: ['GLOBAL_BLOCK'], pause: [], allow: [] }),
    );

    const resolve = (folder: string) => path.join(baseDir, folder);
    const config = loadToolGuardConfig('mygroup', resolve);
    expect(config.block).toContain('GLOBAL_BLOCK');
    expect(config.block).toContain('rm -rf'); // defaults always present
  });

  it('group config takes priority over global', () => {
    const baseDir = path.join(tmpDir, 'groups');
    const groupDir = path.join(baseDir, 'mygroup');
    const globalDir = path.join(baseDir, 'global');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'tool-guard.json'),
      JSON.stringify({ block: ['GROUP_BLOCK'] }),
    );
    fs.writeFileSync(
      path.join(globalDir, 'tool-guard.json'),
      JSON.stringify({ block: ['GLOBAL_BLOCK'] }),
    );

    const resolve = (folder: string) => path.join(baseDir, folder);
    const config = loadToolGuardConfig('mygroup', resolve);
    expect(config.block).toContain('GROUP_BLOCK');
    expect(config.block).not.toContain('GLOBAL_BLOCK'); // group wins
  });

  it('group config cannot remove default block patterns', () => {
    const groupDir = path.join(tmpDir, 'sneaky');
    fs.mkdirSync(groupDir, { recursive: true });
    // Attacker tries to set block to empty
    fs.writeFileSync(
      path.join(groupDir, 'tool-guard.json'),
      JSON.stringify({ block: [] }),
    );

    const config = loadToolGuardConfig('sneaky', () => groupDir);
    // Default block patterns survive
    expect(config.block).toContain('rm -rf');
    expect(config.block).toContain('DROP TABLE');
    expect(config.block.length).toBe(DEFAULT_CONFIG.block.length);
  });

  it('returns defaults when no config exists', () => {
    const config = loadToolGuardConfig('nonexistent', () => {
      throw new Error('not found');
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('handles invalid JSON gracefully', () => {
    const groupDir = path.join(tmpDir, 'badgroup');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'tool-guard.json'), 'not json');

    const config = loadToolGuardConfig('badgroup', () => groupDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('applies zod defaults for partial config file and merges block', () => {
    const groupDir = path.join(tmpDir, 'partial');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'tool-guard.json'),
      JSON.stringify({ block: ['BAD'] }),
    );

    const config = loadToolGuardConfig('partial', () => groupDir);
    expect(config.block).toContain('BAD');
    expect(config.block).toContain('rm -rf'); // defaults merged
    expect(config.pause).toEqual([]);
    expect(config.allow).toEqual([]);
  });
});
