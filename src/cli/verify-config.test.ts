import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';

import {
  verifyComponent,
  verifyAllComponents,
  VALID_COMPONENTS,
} from './verify-config.js';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

const execSyncMock = vi.mocked(execSync);

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('verify-config', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    execSyncMock.mockReturnValue('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('VALID_COMPONENTS', () => {
    it('contains all expected components', () => {
      expect(VALID_COMPONENTS).toEqual([
        'ops-agent',
        'workers',
        'reviewers',
        'watchdog',
      ]);
    });
  });

  describe('verifyComponent', () => {
    it('returns checks with pass/fail for ops-agent', async () => {
      // Mock dispatch-config API returning valid config
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: {
              provider: 'anthropic',
              model: 'claude-sonnet-4-5-20250929',
              cli_bin: 'claude',
            },
          });
        }
        if (typeof url === 'string' && url.includes('/health')) {
          return mockFetchResponse({
            service: 'nanoclaw',
            status: 'ok',
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      // Mock systemctl active
      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        if (typeof cmd === 'string' && cmd.includes('pgrep')) return '';
        if (typeof cmd === 'string' && cmd.includes('tmux')) return '';
        return '';
      });

      const result = await verifyComponent('ops-agent');

      expect(result.component).toBe('ops-agent');
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.summary.passed).toBeGreaterThan(0);

      // Config source should pass since we returned valid API data
      const configSourceCheck = result.checks.find(
        (c) => c.label === 'Config source',
      );
      expect(configSourceCheck).toBeDefined();
      expect(configSourceCheck!.pass).toBe(true);
      expect(configSourceCheck!.actual).toBe('api');
    });

    it('flags failed checks when API is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active')) {
          throw new Error('not active');
        }
        return '';
      });

      const result = await verifyComponent('ops-agent');

      const configSourceCheck = result.checks.find(
        (c) => c.label === 'Config source',
      );
      expect(configSourceCheck).toBeDefined();
      expect(configSourceCheck!.pass).toBe(false);
      expect(configSourceCheck!.actual).toBe('env-fallback');
      expect(configSourceCheck!.fix).toBeDefined();
    });

    it('returns checks for workers component', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'anthropic', cli_bin: 'claude' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      const result = await verifyComponent('workers');

      expect(result.component).toBe('workers');
      expect(result.checks.length).toBeGreaterThan(0);

      // Check parallel dispatch mode appears
      const parallelCheck = result.checks.find(
        (c) => c.label === 'Parallel dispatch mode',
      );
      expect(parallelCheck).toBeDefined();

      // Check worker slot count
      const slotCheck = result.checks.find(
        (c) => c.label === 'Worker slot count',
      );
      expect(slotCheck).toBeDefined();
      expect(slotCheck!.actual).toBe('4');
    });

    it('returns checks for reviewers component', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'anthropic' },
          });
        }
        if (typeof url === 'string' && url.includes('/health')) {
          return mockFetchResponse({ service: 'nanoclaw', status: 'ok' });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      const result = await verifyComponent('reviewers');

      expect(result.component).toBe('reviewers');
      expect(result.checks.length).toBeGreaterThan(0);

      // Health endpoint check should be present
      const healthCheck = result.checks.find(
        (c) => c.label === 'Health endpoint',
      );
      expect(healthCheck).toBeDefined();
    });

    it('returns checks for watchdog component', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'anthropic' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        if (typeof cmd === 'string' && cmd.includes('tmux')) return '';
        return '';
      });

      const result = await verifyComponent('watchdog');

      expect(result.component).toBe('watchdog');

      // Watchdog interval check
      const intervalCheck = result.checks.find(
        (c) => c.label === 'Watchdog interval',
      );
      expect(intervalCheck).toBeDefined();
      expect(intervalCheck!.pass).toBe(true);

      // Grace period check
      const graceCheck = result.checks.find(
        (c) => c.label === 'Slot grace period',
      );
      expect(graceCheck).toBeDefined();
      expect(graceCheck!.pass).toBe(true);
    });

    it('passes provider check when API returns any provider (dynamic expected values)', async () => {
      // API returns a non-default provider — this should PASS because
      // the API is the source of truth for expected values
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'openai', cli_bin: 'openai-cli' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        return '';
      });

      const result = await verifyComponent('ops-agent');

      // Provider should pass — API value is the expected value
      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck).toBeDefined();
      expect(providerCheck!.pass).toBe(true);
      expect(providerCheck!.expected).toBe('openai');
      expect(providerCheck!.actual).toBe('openai');

      // CLI binary should also pass
      const cliBinCheck = result.checks.find((c) => c.label === 'CLI binary');
      expect(cliBinCheck).toBeDefined();
      expect(cliBinCheck!.pass).toBe(true);
      expect(cliBinCheck!.expected).toBe('openai-cli');
      expect(cliBinCheck!.actual).toBe('openai-cli');
    });

    it('passes validation when API returns provider=kimi', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'kimi', model: 'kimi-latest', cli_bin: 'kimi' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        return '';
      });

      const result = await verifyComponent('ops-agent');

      // Provider=kimi should pass — API is the source of truth
      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck).toBeDefined();
      expect(providerCheck!.pass).toBe(true);
      expect(providerCheck!.expected).toBe('kimi');
      expect(providerCheck!.actual).toBe('kimi');

      // CLI binary=kimi should pass
      const cliBinCheck = result.checks.find((c) => c.label === 'CLI binary');
      expect(cliBinCheck).toBeDefined();
      expect(cliBinCheck!.pass).toBe(true);
      expect(cliBinCheck!.expected).toBe('kimi');
      expect(cliBinCheck!.actual).toBe('kimi');

      // Model should report kimi-latest
      const modelCheck = result.checks.find((c) => c.label === 'Model');
      expect(modelCheck).toBeDefined();
      expect(modelCheck!.expected).toBe('kimi-latest');
    });

    it('reports env fallback values when API is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        return '';
      });

      const result = await verifyComponent('ops-agent');

      // Config source should fail
      const configSourceCheck = result.checks.find(
        (c) => c.label === 'Config source',
      );
      expect(configSourceCheck!.pass).toBe(false);
      expect(configSourceCheck!.actual).toBe('env-fallback');

      // Provider should still pass when env default matches fallback
      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck).toBeDefined();
      expect(providerCheck!.pass).toBe(true);
      expect(providerCheck!.expected).toBe('claude');
      expect(providerCheck!.actual).toBe('claude');
    });
  });

  describe('verifyAllComponents', () => {
    it('returns results for all components', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({ success: true, data: { provider: 'anthropic' } }),
      );

      execSyncMock.mockReturnValue('');

      const results = await verifyAllComponents();

      expect(results.length).toBe(VALID_COMPONENTS.length);
      expect(results.map((r) => r.component)).toEqual(VALID_COMPONENTS);
    });

    it('each result has a summary with counts', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({ success: true, data: { provider: 'anthropic' } }),
      );

      const results = await verifyAllComponents();

      for (const result of results) {
        expect(result.summary).toHaveProperty('passed');
        expect(result.summary).toHaveProperty('failed');
        expect(result.summary.passed + result.summary.failed).toBe(
          result.checks.length,
        );
      }
    });
  });

  describe('workers parallel dispatch kill switch', () => {
    it('detects DISPATCH_PARALLEL=false as kill switch', async () => {
      process.env.DISPATCH_PARALLEL = 'false';

      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'anthropic' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      const result = await verifyComponent('workers');

      const parallelCheck = result.checks.find(
        (c) => c.label === 'Parallel dispatch mode',
      );
      expect(parallelCheck).toBeDefined();
      expect(parallelCheck!.pass).toBe(false);
      expect(parallelCheck!.actual).toContain('kill-switch');
      expect(parallelCheck!.fix).toBeDefined();

      delete process.env.DISPATCH_PARALLEL;
    });
  });

  describe('dynamic expected values across components', () => {
    it('workers passes with provider=kimi from API', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'kimi', cli_bin: 'kimi' },
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      const result = await verifyComponent('workers');

      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck!.pass).toBe(true);
      expect(providerCheck!.expected).toBe('kimi');
    });

    it('reviewers passes with provider=kimi from API', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: { provider: 'kimi', cli_bin: 'kimi' },
          });
        }
        if (typeof url === 'string' && url.includes('/health')) {
          return mockFetchResponse({ service: 'nanoclaw', status: 'ok' });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      const result = await verifyComponent('reviewers');

      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck!.pass).toBe(true);
      expect(providerCheck!.expected).toBe('kimi');
    });

    it('uses env fallback when API returns empty data', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/dispatch-config/')) {
          return mockFetchResponse({
            success: true,
            data: {},
          });
        }
        return mockFetchResponse({ success: true, data: {} });
      });

      execSyncMock.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('is-active'))
          return 'active';
        return '';
      });

      const result = await verifyComponent('ops-agent');

      // API is reachable but returns no provider/cli_bin — use API values (empty)
      // which fall back to env values. Provider check should still pass
      // because API returned successfully (even if empty), so the pass logic
      // uses the `apiConfig ? true : ...` branch.
      const providerCheck = result.checks.find((c) => c.label === 'Provider');
      expect(providerCheck!.pass).toBe(true);
    });
  });
});
