import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { emptyConfigForTest, parseMcpServerConfig, readContainerConfig } from './container-config.js';

describe('parseMcpServerConfig — backward compat (stdio)', () => {
  it('accepts the existing supergateway shape with no `type`', () => {
    const cfg = parseMcpServerConfig('qmd-public', {
      command: 'npx',
      args: ['-y', 'supergateway', '--streamableHttp', 'http://host.docker.internal:7333/mcp', '--logLevel', 'none'],
      instructions: 'QMD public index — mcp__qmd-public__query',
    });
    expect(cfg).toEqual({
      command: 'npx',
      args: ['-y', 'supergateway', '--streamableHttp', 'http://host.docker.internal:7333/mcp', '--logLevel', 'none'],
      instructions: 'QMD public index — mcp__qmd-public__query',
    });
  });

  it('accepts stdio with explicit type', () => {
    const cfg = parseMcpServerConfig('foo', { type: 'stdio', command: 'bun', args: ['run', 'x.ts'] });
    expect(cfg).toEqual({ type: 'stdio', command: 'bun', args: ['run', 'x.ts'] });
  });

  it('accepts stdio with env', () => {
    const cfg = parseMcpServerConfig('foo', { command: 'node', env: { TOKEN: 'x' } });
    expect(cfg).toEqual({ command: 'node', env: { TOKEN: 'x' } });
  });
});

describe('parseMcpServerConfig — new transports', () => {
  it('accepts http', () => {
    const cfg = parseMcpServerConfig('qmd', { type: 'http', url: 'http://host.docker.internal:7333/mcp' });
    expect(cfg).toEqual({ type: 'http', url: 'http://host.docker.internal:7333/mcp' });
  });

  it('accepts sse', () => {
    const cfg = parseMcpServerConfig('qmd', { type: 'sse', url: 'http://host.docker.internal:7333/sse' });
    expect(cfg).toEqual({ type: 'sse', url: 'http://host.docker.internal:7333/sse' });
  });

  it('accepts streamableHttp', () => {
    const cfg = parseMcpServerConfig('qmd', {
      type: 'streamableHttp',
      url: 'http://host.docker.internal:7333/mcp',
    });
    expect(cfg).toEqual({ type: 'streamableHttp', url: 'http://host.docker.internal:7333/mcp' });
  });

  it('accepts headers on http', () => {
    const cfg = parseMcpServerConfig('q', {
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect(cfg).toEqual({
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('preserves `instructions` on URL transports', () => {
    const cfg = parseMcpServerConfig('q', {
      type: 'streamableHttp',
      url: 'http://host.docker.internal:7333/mcp',
      instructions: 'hello',
    });
    expect(cfg.instructions).toBe('hello');
  });
});

describe('parseMcpServerConfig — validation failures', () => {
  it('rejects both command and url set', () => {
    expect(() => parseMcpServerConfig('bad', { command: 'npx', url: 'http://x' })).toThrow(/cannot set both command and url/);
  });

  it('rejects bare url with no type', () => {
    expect(() => parseMcpServerConfig('bad', { url: 'http://x' })).toThrow(/type/);
  });

  it("rejects type:'http' with no url", () => {
    expect(() => parseMcpServerConfig('bad', { type: 'http' })).toThrow(/url/);
  });

  it("rejects type:'sse' with no url", () => {
    expect(() => parseMcpServerConfig('bad', { type: 'sse' })).toThrow(/url/);
  });

  it("rejects type:'streamableHttp' with no url", () => {
    expect(() => parseMcpServerConfig('bad', { type: 'streamableHttp' })).toThrow(/url/);
  });

  it("rejects type:'stdio' with no command", () => {
    expect(() => parseMcpServerConfig('bad', { type: 'stdio' })).toThrow(/command/);
  });

  it('rejects empty config (neither command nor url)', () => {
    expect(() => parseMcpServerConfig('bad', {})).toThrow();
  });

  it('rejects command + url + type combination', () => {
    expect(() => parseMcpServerConfig('bad', { type: 'http', command: 'npx', url: 'http://x' })).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => parseMcpServerConfig('bad', { type: 'websocket', url: 'ws://x' })).toThrow(/type/);
  });

  it("rejects type:'stdio' with url set", () => {
    expect(() => parseMcpServerConfig('bad', { type: 'stdio', command: 'npx', url: 'http://x' })).toThrow();
  });

  it('error messages include the server name for diagnosability', () => {
    expect(() => parseMcpServerConfig('qmd-public', { command: 'npx', url: 'http://x' })).toThrow(/qmd-public/);
  });
});

describe('emptyConfig — new shape', () => {
  it("emits qmd-public with type:'streamableHttp' and url, no command/args", () => {
    const cfg = emptyConfigForTest();
    const qmd = cfg.mcpServers['qmd-public'];
    expect(qmd).toBeDefined();
    expect(qmd).toMatchObject({
      type: 'streamableHttp',
      url: 'http://host.docker.internal:7333/mcp',
    });
    expect(qmd.command).toBeUndefined();
    expect(qmd.args).toBeUndefined();
    expect(qmd.instructions).toMatch(/QMD public index/);
  });

  it('still emits jibrain and tools mounts', () => {
    const cfg = emptyConfigForTest();
    const paths = cfg.additionalMounts.map((m) => m.containerPath).sort();
    expect(paths).toEqual(['jibrain', 'tools']);
    expect(cfg.additionalMounts.every((m) => m.readonly === true)).toBe(true);
  });
});

describe('readContainerConfig — disk-level backward compat', () => {
  // GROUPS_DIR is resolved at module-load time from process.cwd(), so we
  // can't redirect it via chdir. Write to unique subdirs under the real
  // groups/ tree and clean up after.
  const created: string[] = [];

  function makeFolder(prefix: string): string {
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    const dir = fs.mkdtempSync(path.join(GROUPS_DIR, `test-${prefix}-`));
    created.push(dir);
    return path.basename(dir);
  }

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the existing supergateway shape unchanged (45+ channel sentinel)', () => {
    const folder = makeFolder('legacy');
    const oldShape = {
      mcpServers: {
        'qmd-public': {
          command: 'npx',
          args: ['-y', 'supergateway', '--streamableHttp', 'http://host.docker.internal:7333/mcp', '--logLevel', 'none'],
          instructions: 'QMD public',
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    };
    fs.writeFileSync(path.join(GROUPS_DIR, folder, 'container.json'), JSON.stringify(oldShape));
    const cfg = readContainerConfig(folder);
    expect(cfg.mcpServers['qmd-public'].command).toBe('npx');
    expect(cfg.mcpServers['qmd-public'].args).toEqual(oldShape.mcpServers['qmd-public'].args);
    expect(cfg.mcpServers['qmd-public'].url).toBeUndefined();
  });

  it('reads the new streamableHttp shape unchanged', () => {
    const folder = makeFolder('modern');
    const newShape = {
      mcpServers: {
        'qmd-public': {
          type: 'streamableHttp',
          url: 'http://host.docker.internal:7333/mcp',
          instructions: 'QMD public',
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    };
    fs.writeFileSync(path.join(GROUPS_DIR, folder, 'container.json'), JSON.stringify(newShape));
    const cfg = readContainerConfig(folder);
    expect(cfg.mcpServers['qmd-public']).toMatchObject({
      type: 'streamableHttp',
      url: 'http://host.docker.internal:7333/mcp',
    });
    expect(cfg.mcpServers['qmd-public'].command).toBeUndefined();
  });

  it('drops invalid MCP entries with a console warning, keeping valid ones', () => {
    const folder = makeFolder('mixed');
    const mixed = {
      mcpServers: {
        good: { command: 'echo', args: ['ok'] },
        bad: { command: 'npx', url: 'http://x' },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    };
    fs.writeFileSync(path.join(GROUPS_DIR, folder, 'container.json'), JSON.stringify(mixed));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = readContainerConfig(folder);
    expect(cfg.mcpServers.good).toBeDefined();
    expect(cfg.mcpServers.bad).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('falls back to emptyConfig (new shape) for malformed JSON', () => {
    const folder = makeFolder('broken');
    fs.writeFileSync(path.join(GROUPS_DIR, folder, 'container.json'), '{not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = readContainerConfig(folder);
    expect(cfg.mcpServers['qmd-public']).toMatchObject({ type: 'streamableHttp' });
    errSpy.mockRestore();
  });
});
