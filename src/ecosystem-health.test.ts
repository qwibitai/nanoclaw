import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkService,
  checkEcosystemHealth,
  formatHealthTable,
  SERVICE_REGISTRY,
  type ServiceEntry,
  type EcosystemHealthSnapshot,
} from './ecosystem-health.js';

describe('ecosystem-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SERVICE_REGISTRY', () => {
    it('contains at least 15 services', () => {
      expect(SERVICE_REGISTRY.length).toBeGreaterThanOrEqual(15);
    });

    it('marks ping-mobile as skipped', () => {
      const pingMobile = SERVICE_REGISTRY.find(
        (s) => s.name === 'ping-mobile',
      );
      expect(pingMobile).toBeDefined();
      expect(pingMobile!.skip).toBe(true);
    });

    it('all non-skipped services have a URL', () => {
      for (const s of SERVICE_REGISTRY) {
        if (!s.skip) {
          expect(s.url).toBeTruthy();
        }
      }
    });
  });

  describe('checkService', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns up for a 200 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await checkService({
        name: 'test-svc',
        url: 'http://localhost:9999/health',
      });

      expect(result.status).toBe('up');
      expect(result.name).toBe('test-svc');
      expect(result.latencyMs).toBeTypeOf('number');
      expect(result.error).toBeUndefined();
    });

    it('returns down for a non-200 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await checkService({
        name: 'test-svc',
        url: 'http://localhost:9999/health',
      });

      expect(result.status).toBe('down');
      expect(result.error).toBe('HTTP 503');
      expect(result.latencyMs).toBeTypeOf('number');
    });

    it('returns down for a connection error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await checkService({
        name: 'test-svc',
        url: 'http://localhost:9999/health',
      });

      expect(result.status).toBe('down');
      expect(result.error).toBe('ECONNREFUSED');
      expect(result.latencyMs).toBeTypeOf('number');
    });

    it('returns timeout for a timeout error', async () => {
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr);

      const result = await checkService(
        { name: 'test-svc', url: 'http://localhost:9999/health' },
        5000,
      );

      expect(result.status).toBe('timeout');
      expect(result.error).toContain('timeout');
      expect(result.latencyMs).toBeTypeOf('number');
    });

    it('returns skipped result for skip entries', async () => {
      globalThis.fetch = vi.fn();

      const result = await checkService({
        name: 'skip-svc',
        url: '',
        skip: true,
        skipReason: 'no health endpoint',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('no health endpoint');
      expect(result.latencyMs).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('checkEcosystemHealth', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('checks all services and returns a snapshot', async () => {
      const services: ServiceEntry[] = [
        { name: 'svc-a', url: 'http://localhost:1/health' },
        { name: 'svc-b', url: 'http://localhost:2/health' },
        { name: 'svc-c', url: '', skip: true, skipReason: 'no endpoint' },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const snapshot = await checkEcosystemHealth(services);

      expect(snapshot.results).toHaveLength(3);
      expect(snapshot.summary.up).toBe(2);
      expect(snapshot.summary.skipped).toBe(1);
      expect(snapshot.summary.down).toBe(0);
      expect(snapshot.summary.timeout).toBe(0);
      expect(snapshot.timestamp).toBeTruthy();
    });

    it('counts down and timeout statuses correctly', async () => {
      const services: ServiceEntry[] = [
        { name: 'up-svc', url: 'http://localhost:1/health' },
        { name: 'down-svc', url: 'http://localhost:2/health' },
        { name: 'timeout-svc', url: 'http://localhost:3/health' },
      ];

      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':1')) return Promise.resolve({ ok: true, status: 200 });
        if (url.includes(':2'))
          return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.reject(timeoutErr);
      });

      const snapshot = await checkEcosystemHealth(services);

      expect(snapshot.summary.up).toBe(1);
      expect(snapshot.summary.down).toBe(1);
      expect(snapshot.summary.timeout).toBe(1);
    });
  });

  describe('formatHealthTable', () => {
    const snapshot: EcosystemHealthSnapshot = {
      timestamp: '2026-04-23T12:00:00.000Z',
      results: [
        {
          name: 'svc-up',
          url: 'http://localhost:3000/health',
          status: 'up',
          latencyMs: 42,
        },
        {
          name: 'svc-down',
          url: 'http://localhost:3001/health',
          status: 'down',
          latencyMs: 5,
          error: 'ECONNREFUSED',
        },
        {
          name: 'svc-timeout',
          url: 'http://localhost:3002/health',
          status: 'timeout',
          latencyMs: 5001,
          error: 'timeout after 5000ms',
        },
        {
          name: 'svc-skip',
          url: '(none)',
          status: 'down',
          latencyMs: null,
          skipped: true,
          skipReason: 'no endpoint',
        },
      ],
      summary: { up: 1, down: 1, timeout: 1, skipped: 1 },
    };

    it('includes all service names', () => {
      const output = formatHealthTable(snapshot);
      expect(output).toContain('svc-up');
      expect(output).toContain('svc-down');
      expect(output).toContain('svc-timeout');
      expect(output).toContain('svc-skip');
    });

    it('includes status indicators', () => {
      const output = formatHealthTable(snapshot);
      expect(output).toContain('\u2713'); // checkmark for up
      expect(output).toContain('\u2717'); // x for down
      expect(output).toContain('\u23f1'); // timer for timeout
      expect(output).toContain('\u2212'); // minus for skip
    });

    it('includes latency values', () => {
      const output = formatHealthTable(snapshot);
      expect(output).toContain('42ms');
      expect(output).toContain('5ms');
      expect(output).toContain('5001ms');
    });

    it('includes summary line', () => {
      const output = formatHealthTable(snapshot);
      expect(output).toContain('1/3 up');
      expect(output).toContain('1 down');
      expect(output).toContain('1 timeout');
      expect(output).toContain('1 skipped');
    });

    it('shows errors in verbose mode', () => {
      const output = formatHealthTable(snapshot, true);
      expect(output).toContain('ECONNREFUSED');
      expect(output).toContain('timeout after 5000ms');
    });

    it('hides errors in non-verbose mode', () => {
      const output = formatHealthTable(snapshot, false);
      expect(output).not.toContain('ECONNREFUSED');
      expect(output).not.toContain('timeout after 5000ms');
    });

    it('includes header', () => {
      const output = formatHealthTable(snapshot);
      expect(output).toContain('Ecosystem Health Check');
    });
  });
});
