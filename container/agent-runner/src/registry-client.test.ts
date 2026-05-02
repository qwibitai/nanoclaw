import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BotRegistry } from './registry-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs for cache operations
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const SAMPLE_REGISTRY_RESPONSE = [
  {
    bot_id: '90162a8a-70eb-4d53-ab7a-359380ac34f2',
    name: 'DB',
    config: {
      ssh_target: 'ubuntu@100.88.246.12',
      container: 'openclaw-openclaw-gateway-1',
      framework: 'openclaw',
      config_paths: ['~/.openclaw/openclaw.json'],
      github_issues_repo: 'neuron-box/db-issues',
      github_source_repo: 'neuron-box/openclaw',
      local_project_dir: '~/personal/projects/claw/DB_EC2',
    },
  },
  {
    bot_id: 'ee088199-6990-4818-ae58-a1be1cc8d4bb',
    name: 'Nook',
    config: {
      ssh_target: 'tomerhamam@100.99.148.99',
      container: 'letta-server',
      framework: 'letta',
      config_paths: [],
      github_issues_repo: 'neuron-box/nook-issues',
      github_source_repo: '',
      local_project_dir: '~/personal/projects/nook',
    },
  },
];

describe('BotRegistry', () => {
  let registry: BotRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new BotRegistry('http://100.99.148.99:3100', '/tmp/test-cache.json');
  });

  it('fetches bot configs from API on init', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });

    await registry.init();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://100.99.148.99:3100/api/bots/configs',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(registry.getBot('DB').name).toBe('DB');
    expect(registry.getBot('nook').name).toBe('Nook');
  });

  it('throws for unknown bot name', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });
    await registry.init();

    expect(() => registry.getBot('nonexistent')).toThrow('Unknown bot');
  });

  it('case-insensitive bot lookup', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });
    await registry.init();

    expect(registry.getBot('db').name).toBe('DB');
    expect(registry.getBot('DB').name).toBe('DB');
    expect(registry.getBot('Db').name).toBe('DB');
  });

  it('getAllBots returns all configs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });
    await registry.init();

    const all = registry.getAllBots();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it('sends Authorization header when token is provided', async () => {
    const authedRegistry = new BotRegistry('http://100.99.148.99:3100', '/tmp/test-cache.json', 'my-secret-token');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });

    await authedRegistry.init();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://100.99.148.99:3100/api/bots/configs',
      expect.objectContaining({
        headers: { Authorization: 'Bearer my-secret-token' },
      }),
    );
  });

  it('does not send Authorization header when no token is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });

    await registry.init();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://100.99.148.99:3100/api/bots/configs',
      expect.objectContaining({
        headers: {},
      }),
    );
  });

  it('refresh detects added and removed bots', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_REGISTRY_RESPONSE,
    });
    await registry.init();

    // Refresh with only DB (Nook removed)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [SAMPLE_REGISTRY_RESPONSE[0]],
    });
    const diff = await registry.refresh();

    expect(diff.removed).toContain('nook');
    expect(diff.source).toBe('api');
  });
});
