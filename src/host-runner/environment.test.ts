import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerInput } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';

import { buildEnvironment } from './environment.js';

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));
vi.mock('./claude-path.js', () => ({
  findClaudePath: vi.fn(() => '/mock/claude'),
}));

const baseInput: ContainerInput = {
  prompt: 'hi',
  groupFolder: 'group-a',
  chatJid: 'chat@g.us',
  isMain: true,
};

const basePaths = {
  ipcDir: '/ipc',
  groupDir: '/group',
  globalDir: '/global',
  extraDir: '/extra',
  claudeHome: '/home/.claude',
};

const baseGroup: RegisteredGroup = {
  name: 'g',
  folder: 'group-a',
  trigger: '',
  added_at: '',
};

describe('buildEnvironment', () => {
  const origPath = process.env.PATH;
  const origClaudeCodePath = process.env.CLAUDE_CODE_PATH;

  beforeEach(async () => {
    const { readEnvFile } = await import('../env.js');
    (readEnvFile as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origClaudeCodePath === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = origClaudeCodePath;
    vi.restoreAllMocks();
  });

  it('wires mount points and MCP context into env vars', () => {
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.NANOCLAW_IPC_DIR).toBe('/ipc');
    expect(env.NANOCLAW_GROUP_DIR).toBe('/group');
    expect(env.NANOCLAW_GLOBAL_DIR).toBe('/global');
    expect(env.NANOCLAW_EXTRA_DIR).toBe('/extra');
    expect(env.NANOCLAW_CHAT_JID).toBe('chat@g.us');
    expect(env.NANOCLAW_GROUP_FOLDER).toBe('group-a');
    expect(env.NANOCLAW_IS_MAIN).toBe('1');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/.claude');
  });

  it('formats NANOCLAW_IS_MAIN as "0" for non-main groups', () => {
    const env = buildEnvironment(
      baseGroup,
      { ...baseInput, isMain: false },
      basePaths,
    );
    expect(env.NANOCLAW_IS_MAIN).toBe('0');
  });

  it('merges .env auth credentials via readEnvFile', async () => {
    const { readEnvFile } = await import('../env.js');
    (readEnvFile as ReturnType<typeof vi.fn>).mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
    });
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(env.ANTHROPIC_API_KEY).toBe('key');
  });

  it('prepends node bin dir to PATH when missing', () => {
    process.env.PATH = '/usr/bin:/bin';
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.PATH.startsWith('/')).toBe(true);
    expect(env.PATH).toContain('/usr/bin:/bin');
    expect(env.PATH.includes(':')).toBe(true);
  });

  it('leaves PATH unchanged when node bin dir is already present', () => {
    const nodeBinDir = path.dirname(process.execPath);
    process.env.PATH = `${nodeBinDir}:/usr/bin`;
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.PATH).toBe(`${nodeBinDir}:/usr/bin`);
  });

  it('prefers CLAUDE_CODE_PATH env var over the resolved default', () => {
    process.env.CLAUDE_CODE_PATH = '/custom/claude';
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.CLAUDE_CODE_PATH).toBe('/custom/claude');
  });

  it('falls back to findClaudePath when CLAUDE_CODE_PATH is unset', () => {
    delete process.env.CLAUDE_CODE_PATH;
    const env = buildEnvironment(baseGroup, baseInput, basePaths);
    expect(env.CLAUDE_CODE_PATH).toBe('/mock/claude');
  });
});
