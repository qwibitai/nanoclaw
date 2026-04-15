import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

describe('MCP bridge config builder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('registers nanoclaw server when mcp file exists', async () => {
    const originalExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr.endsWith('nanoclaw-mcp.js')) return true;
      return originalExists(pathStr);
    });

    vi.resetModules();
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('nanoclaw');
    expect(configs['nanoclaw'].env.NANOCLAW_CHAT_JID).toBe('test@chat');
    expect(configs['nanoclaw'].env.NANOCLAW_IS_MAIN).toBe('0');
  });

  it('registers gmail server when credentials exist', async () => {
    const originalExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === '/home/node/.gmail-mcp/credentials.json') return true;
      return originalExists(pathStr);
    });

    vi.resetModules();
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('gmail-personal');
  });

  it('registers notion server when token env var is set', async () => {
    process.env.NOTION_TOKEN = 'test-notion-token';

    vi.resetModules();
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('notion');

    delete process.env.NOTION_TOKEN;
  });

  it('returns empty config when no servers are available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    vi.resetModules();
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(Object.keys(configs)).toHaveLength(0);
  });
});
