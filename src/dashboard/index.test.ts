/**
 * Tests for startDashboard():
 * - calls ensureServerStarted exactly once
 * - is idempotent (routes not double-registered)
 * - static splat route registered last (after all /dashboard/api/* routes)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  try {
    const mod = await import('../webhook-server.js');
    await mod.stopWebhookServer();
  } catch {
    // already stopped
  }
});

describe('startDashboard', () => {
  it('test_startDashboard_calls_ensureServerStarted', async () => {
    const whMod = await import('../webhook-server.js');
    const ensureSpy = vi.spyOn(whMod, 'ensureServerStarted');

    const { startDashboard } = await import('./index.js');
    startDashboard();

    expect(ensureSpy).toHaveBeenCalledOnce();
  });

  it('test_startDashboard_idempotent', async () => {
    const routerMod = await import('./router.js');
    const { startDashboard } = await import('./index.js');

    startDashboard();
    startDashboard();

    const routes = routerMod.getRoutes();

    // Each route pattern must appear at most once — no double-registration
    const patternCounts = new Map<string, number>();
    for (const r of routes) {
      const key = `${r.method}:${r.pattern}`;
      patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of patternCounts) {
      expect(count, `Route ${key} registered ${count} times`).toBe(1);
    }
  });

  it('test_startDashboard_static_route_registered_last', async () => {
    const routerMod = await import('./router.js');
    const { startDashboard } = await import('./index.js');

    startDashboard();

    const routes = routerMod.getRoutes();
    const apiRoutes = routes.filter((r) => r.pattern.startsWith('/dashboard/api/'));
    const splatIndex = routes.findIndex((r) => r.pattern === '/dashboard/static/*tail');

    // splat must exist
    expect(splatIndex).toBeGreaterThan(-1);

    // all api routes must appear before the splat
    for (const apiRoute of apiRoutes) {
      const apiIndex = routes.indexOf(apiRoute);
      expect(apiIndex).toBeLessThan(splatIndex);
    }
  });
});
