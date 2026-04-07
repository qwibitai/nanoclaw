import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCopilotAdditionalMcpConfig,
  prepareCopilotWorkspace,
  prepareGeminiWorkspace,
} from './host-agent-assets.js';

const createdPaths: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  while (createdPaths.length > 0) {
    const entry = createdPaths.pop();
    if (entry && fs.existsSync(entry)) {
      fs.rmSync(entry, { recursive: true, force: true });
    }
  }
});

describe('host agent assets', () => {
  it('merges root and group MCP config for copilot', () => {
    const projectRoot = makeTempDir('nanoclaw-root-');
    const groupDir = path.join(projectRoot, 'groups', 'gemini-room');
    fs.mkdirSync(groupDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tavily: { command: 'npx', args: ['-y', 'tavily-mcp'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'GEMINI_API_KEY=gemini_test_key\nNOTION_API_KEY=secret_notion_token\n',
    );
    fs.writeFileSync(
      path.join(groupDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
        },
      }),
    );

    process.chdir(projectRoot);

    const configText = buildCopilotAdditionalMcpConfig(groupDir);
    const config = configText ? JSON.parse(configText) : null;

    expect(config).toMatchObject({
      mcpServers: {
        notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
        tavily: { command: 'npx', args: ['-y', 'tavily-mcp'] },
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
    });
  });

  it('creates gemini workspace settings and syncs skills', () => {
    const projectRoot = makeTempDir('nanoclaw-root-');
    const fakeHome = makeTempDir('nanoclaw-home-');
    const groupDir = path.join(projectRoot, 'groups', 'gemini-room');
    const containerSkillDir = path.join(
      projectRoot,
      'container',
      'skills',
      'status',
    );
    const homeSkillDir = path.join(fakeHome, '.agents', 'skills', 'custom');

    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(containerSkillDir, { recursive: true });
    fs.mkdirSync(homeSkillDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'SYSTEM.md'), '# System Prompt\n');
    fs.writeFileSync(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tavily: { command: 'npx', args: ['-y', 'tavily-mcp'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'NOTION_API_KEY=secret_notion_token\n',
    );
    fs.writeFileSync(
      path.join(containerSkillDir, 'SKILL.md'),
      '---\nname: status\ndescription: status skill\n---\n\n# status\n',
    );
    fs.writeFileSync(
      path.join(homeSkillDir, 'SKILL.md'),
      '---\nname: custom\ndescription: custom skill\n---\n\n# custom\n',
    );

    process.chdir(projectRoot);
    const originalHome = process.env.HOME;
    const originalGithubPat = process.env.GITHUB_MCP_PAT;
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    process.env.HOME = fakeHome;
    process.env.GITHUB_MCP_PAT = 'gho_test_token';
    process.env.GEMINI_API_KEY = 'gemini_test_key';

    try {
      prepareGeminiWorkspace(groupDir);
    } finally {
      process.env.HOME = originalHome;
      process.env.GITHUB_MCP_PAT = originalGithubPat;
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }

    const settings = JSON.parse(
      fs.readFileSync(path.join(groupDir, '.gemini', 'settings.json'), 'utf-8'),
    ) as {
      skillsSupport?: boolean;
      mcpServers?: Record<string, unknown>;
      mcp?: { allowed?: string[] };
    };

    expect(settings.skillsSupport).toBe(true);
    expect(settings.mcpServers).toHaveProperty('tavily');
    expect(settings.mcpServers).toHaveProperty('notion');
    expect(settings.mcpServers?.notion).toMatchObject({
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
    });
    expect(settings.mcpServers).toHaveProperty('github');
    expect(
      (settings.mcpServers?.github as { headers?: { Authorization?: string } })
        .headers?.Authorization,
    ).toBe('Bearer $GITHUB_MCP_PAT');
    expect(settings.mcp?.allowed).toContain('tavily');
    expect(settings.mcp?.allowed).toContain('notion');
    expect(settings.mcp?.allowed).toContain('github');
    expect(
      fs.readFileSync(path.join(groupDir, '.gemini', '.env'), 'utf-8'),
    ).toContain('GITHUB_MCP_PAT=gho_test_token');
    expect(
      fs.readFileSync(path.join(groupDir, '.gemini', '.env'), 'utf-8'),
    ).toContain('GEMINI_API_KEY=gemini_test_key');
    expect(
      fs.existsSync(
        path.join(groupDir, '.agents', 'skills', 'custom', 'SKILL.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(groupDir, '.agents', 'skills', 'status', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(groupDir, '.gemini', 'skills'))).toBe(false);
  });

  it('creates copilot MCP config and project skills', () => {
    const projectRoot = makeTempDir('nanoclaw-root-');
    const fakeHome = makeTempDir('nanoclaw-home-');
    const groupDir = path.join(projectRoot, 'groups', 'copilot-room');
    const containerSkillDir = path.join(
      projectRoot,
      'container',
      'skills',
      'status',
    );
    const homeSkillDir = path.join(fakeHome, '.agents', 'skills', 'custom');

    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(containerSkillDir, { recursive: true });
    fs.mkdirSync(homeSkillDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'SYSTEM.md'), '# System Prompt\n');
    fs.writeFileSync(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tavily: {
            command: 'npx',
            args: ['-y', 'tavily-mcp@0.1.4'],
            env: { TAVILY_API_KEY: 'tvly_test' },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'NOTION_API_KEY=secret_notion_token\n',
    );
    fs.writeFileSync(
      path.join(containerSkillDir, 'SKILL.md'),
      '---\nname: status\ndescription: status skill\n---\n\n# status\n',
    );
    fs.writeFileSync(
      path.join(homeSkillDir, 'SKILL.md'),
      '---\nname: custom\ndescription: custom skill\n---\n\n# custom\n',
    );

    process.chdir(projectRoot);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      prepareCopilotWorkspace(groupDir);
    } finally {
      process.env.HOME = originalHome;
    }

    const copilotConfig = JSON.parse(
      fs.readFileSync(
        path.join(fakeHome, '.copilot', 'mcp-config.json'),
        'utf-8',
      ),
    ) as {
      mcpServers?: Record<
        string,
        { type?: string; url?: string; command?: string }
      >;
    };

    expect(copilotConfig.mcpServers?.tavily).toMatchObject({
      type: 'local',
      command: 'npx',
    });
    expect(copilotConfig.mcpServers?.notion).toMatchObject({
      type: 'local',
      command: 'npx',
    });
    expect(
      fs.existsSync(
        path.join(groupDir, '.claude', 'skills', 'status', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(groupDir, '.claude', 'skills', 'custom', 'SKILL.md'),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(groupDir, 'copilot-instructions.md'), 'utf-8'),
    ).toContain('# System Prompt');
  });
});
