import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_BACKEND_HOME_LIST,
  AGENT_BACKEND_HOME_SPECS,
  CONTAINER_CUSTOM_MCP_DIR,
  resolveAgentBackendHomeDir,
} from './backend-home.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-backend-home-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveAgentBackendHomeDir', () => {
  it('uses the backend metadata home directory names', () => {
    expect(resolveAgentBackendHomeDir(tmpDir, 'claudeCode')).toBe(
      path.join(tmpDir, AGENT_BACKEND_HOME_SPECS.claudeCode.homeDirName),
    );
    expect(resolveAgentBackendHomeDir(tmpDir, 'codex')).toBe(
      path.join(tmpDir, AGENT_BACKEND_HOME_SPECS.codex.homeDirName),
    );
  });
});

describe('AGENT_BACKEND_HOME_SPECS', () => {
  it('declares every backend home mount target', () => {
    expect(AGENT_BACKEND_HOME_SPECS).toMatchObject({
      claudeCode: {
        type: 'claudeCode',
        homeDirName: '.claude',
        containerHomePath: '/home/node/.claude',
      },
      codex: {
        type: 'codex',
        homeDirName: '.codex',
        containerHomePath: '/home/node/.codex',
      },
    });
  });

  it('exposes list values from the same metadata map', () => {
    expect(AGENT_BACKEND_HOME_LIST).toEqual(
      expect.arrayContaining([
        AGENT_BACKEND_HOME_SPECS.claudeCode,
        AGENT_BACKEND_HOME_SPECS.codex,
      ]),
    );
    expect(AGENT_BACKEND_HOME_LIST).toHaveLength(2);
  });

  it('keeps the shared MCP staging directory under the Claude Code home', () => {
    expect(CONTAINER_CUSTOM_MCP_DIR).toBe('/home/node/.claude/mcp');
  });
});

describe('backend home initialization', () => {
  it('initializes Claude Code settings with required env flags', () => {
    const homeDir = path.join(tmpDir, '.claude');

    AGENT_BACKEND_HOME_SPECS.claudeCode.initialize(homeDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'settings.json'), 'utf-8'),
    );
    expect(settings).toEqual({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    });
  });

  it('does not overwrite an existing Claude Code settings file', () => {
    const homeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'settings.json'), '{"custom":true}\n');

    AGENT_BACKEND_HOME_SPECS.claudeCode.initialize(homeDir);

    expect(fs.readFileSync(path.join(homeDir, 'settings.json'), 'utf-8')).toBe(
      '{"custom":true}\n',
    );
  });

  it('initializes Codex home without Claude-specific settings', () => {
    const homeDir = path.join(tmpDir, '.codex');

    AGENT_BACKEND_HOME_SPECS.codex.initialize(homeDir);

    expect(fs.statSync(homeDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(homeDir, 'settings.json'))).toBe(false);
  });
});
