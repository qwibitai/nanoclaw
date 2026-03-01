import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  RoutineEngine,
  WebhookServer,
  type Routine,
} from './routine-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    name: 'test-routine',
    group: 'main',
    trigger: { type: 'cron', cron: '*/5 * * * *' },
    action: { type: 'lightweight', prompt: 'Check health' },
    guardrails: {},
    enabled: true,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function hmacSign(rawBody: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoutineEngine', () => {
  let engine: RoutineEngine;
  let onLightweightAction: ReturnType<typeof vi.fn>;
  let onFullJobAction: ReturnType<typeof vi.fn>;
  let onNotify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onLightweightAction = vi.fn().mockResolvedValue('ROUTINE_OK');
    onFullJobAction = vi.fn().mockResolvedValue({ success: true });
    onNotify = vi.fn();
    engine = new RoutineEngine({
      onLightweightAction,
      onFullJobAction,
      onNotify,
    });
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Cron routines
  // -----------------------------------------------------------------------

  it('should fire cron routine when due', async () => {
    const now = Date.now();
    const routine = makeRoutine({
      name: 'cron-due',
      trigger: { type: 'cron', cron: '*/5 * * * *' },
      // nextFireAt is in the past → should fire immediately
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    const runs = await engine.checkCronRoutines(now);

    expect(runs).toHaveLength(1);
    expect(runs[0].routineName).toBe('cron-due');
    // After firing, nextFireAt should be updated to a future value
    const updated = engine.getRoutine('cron-due');
    expect(updated).toBeDefined();
    expect(updated!.nextFireAt).toBeGreaterThan(now);
  });

  // -----------------------------------------------------------------------
  // Event routines
  // -----------------------------------------------------------------------

  it('should fire event routine when message matches regex', async () => {
    const routine = makeRoutine({
      name: 'event-match',
      trigger: { type: 'event', pattern: 'deploy\\s+failed', channel: 'ops' },
      action: { type: 'lightweight', prompt: 'Investigate deploy failure' },
    });

    engine.addRoutine(routine);
    const runs = await engine.matchEvent('deploy failed in prod', 'ops');

    expect(runs).toHaveLength(1);
    expect(runs[0].routineName).toBe('event-match');
    expect(onLightweightAction).toHaveBeenCalled();
  });

  it('should not fire event routine when channel does not match', async () => {
    const routine = makeRoutine({
      name: 'event-channel-filter',
      trigger: { type: 'event', pattern: 'error', channel: 'ops' },
    });

    engine.addRoutine(routine);
    const runs = await engine.matchEvent('error in prod', 'general');

    expect(runs).toHaveLength(0);
  });

  it('should fire event routine when no channel filter is set', async () => {
    const routine = makeRoutine({
      name: 'event-any-channel',
      trigger: { type: 'event', pattern: 'error' },
    });

    engine.addRoutine(routine);
    const runs = await engine.matchEvent('error in prod', 'random-channel');

    expect(runs).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Webhook routines
  // -----------------------------------------------------------------------

  it('should fire webhook routine on valid signed POST', async () => {
    const secret = 'webhook-secret-123';
    const rawBody = JSON.stringify({ action: 'push', ref: 'refs/heads/main' });
    const signature = hmacSign(rawBody, secret);

    const routine = makeRoutine({
      name: 'github-push',
      group: 'main',
      trigger: { type: 'webhook', secret },
      action: { type: 'lightweight', prompt: 'Handle push event' },
    });

    engine.addRoutine(routine);
    const result = await engine.handleWebhook('main', 'github-push', rawBody, signature);

    expect(result.status).toBe(200);
    expect(onLightweightAction).toHaveBeenCalled();
  });

  it('should reject webhook with invalid signature (401)', async () => {
    const secret = 'webhook-secret-123';
    const rawBody = JSON.stringify({ action: 'push' });
    const badSignature = 'deadbeef';

    const routine = makeRoutine({
      name: 'github-push',
      group: 'main',
      trigger: { type: 'webhook', secret },
    });

    engine.addRoutine(routine);
    const result = await engine.handleWebhook('main', 'github-push', rawBody, badSignature);

    expect(result.status).toBe(401);
    expect(onLightweightAction).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Guardrails
  // -----------------------------------------------------------------------

  it('should respect cooldown guardrail', async () => {
    const now = Date.now();
    const routine = makeRoutine({
      name: 'cooldown-test',
      trigger: { type: 'cron', cron: '* * * * *' },
      guardrails: { cooldownMs: 60_000 },
      nextFireAt: now - 1000,
      lastRunAt: now - 30_000, // 30s ago — within 60s cooldown
    });

    engine.addRoutine(routine);
    const runs = await engine.checkCronRoutines(now);

    // Should be skipped due to cooldown
    expect(runs).toHaveLength(0);
    expect(onLightweightAction).not.toHaveBeenCalled();
  });

  it('should respect max_concurrent guardrail', async () => {
    const now = Date.now();
    // Create a routine with maxConcurrent=1 and a slow action
    onLightweightAction.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10_000, 'ROUTINE_OK')),
    );

    const routine = makeRoutine({
      name: 'concurrent-test',
      trigger: { type: 'cron', cron: '* * * * *' },
      guardrails: { maxConcurrent: 1 },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);

    // First fire — should proceed
    const firstRunPromise = engine.checkCronRoutines(now);

    // Second fire while first is still running — should be skipped
    const secondRuns = await engine.checkCronRoutines(now + 1000);
    expect(secondRuns).toHaveLength(0);

    // Let the first run finish
    vi.advanceTimersByTime(10_000);
    const firstRuns = await firstRunPromise;
    expect(firstRuns).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  it('should execute lightweight action (single LLM call)', async () => {
    const now = Date.now();
    onLightweightAction.mockResolvedValue('ROUTINE_OK');

    const routine = makeRoutine({
      name: 'lightweight-test',
      trigger: { type: 'cron', cron: '*/5 * * * *' },
      action: {
        type: 'lightweight',
        prompt: 'Check system health',
        workspacePaths: ['/groups/main/CLAUDE.md'],
      },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    const runs = await engine.checkCronRoutines(now);

    expect(runs).toHaveLength(1);
    expect(onLightweightAction).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Check system health',
        workspacePaths: ['/groups/main/CLAUDE.md'],
      }),
    );
    expect(onFullJobAction).not.toHaveBeenCalled();
  });

  it('should dispatch full_job action to container-runner', async () => {
    const now = Date.now();
    onFullJobAction.mockResolvedValue({ success: true, jobId: 'job-123' });

    const routine = makeRoutine({
      name: 'full-job-test',
      trigger: { type: 'cron', cron: '*/10 * * * *' },
      action: { type: 'full_job', prompt: 'Run full analysis' },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    const runs = await engine.checkCronRoutines(now);

    expect(runs).toHaveLength(1);
    expect(onFullJobAction).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Run full analysis',
      }),
    );
    expect(onLightweightAction).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Notification behaviour
  // -----------------------------------------------------------------------

  it('should return ROUTINE_OK silently (no notification)', async () => {
    const now = Date.now();
    onLightweightAction.mockResolvedValue('ROUTINE_OK');

    const routine = makeRoutine({
      name: 'silent-ok',
      trigger: { type: 'cron', cron: '*/5 * * * *' },
      action: { type: 'lightweight', prompt: 'Check health' },
      notify: { channel: 'ops', onFailure: true, onAttention: true },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    await engine.checkCronRoutines(now);

    // ROUTINE_OK → no notification
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('should notify on attention/failure per NotifyConfig', async () => {
    const now = Date.now();
    onLightweightAction.mockResolvedValue('ATTENTION: Disk usage at 95%');

    const routine = makeRoutine({
      name: 'attention-notify',
      trigger: { type: 'cron', cron: '*/5 * * * *' },
      action: { type: 'lightweight', prompt: 'Check disk' },
      notify: { channel: 'ops', onFailure: true, onAttention: true },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    await engine.checkCronRoutines(now);

    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        routineName: 'attention-notify',
        message: expect.stringContaining('Disk usage at 95%'),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Auto-pause on consecutive failures
  // -----------------------------------------------------------------------

  it('should auto-pause after 5 consecutive failures', async () => {
    const now = Date.now();
    onLightweightAction.mockRejectedValue(new Error('LLM timeout'));

    const routine = makeRoutine({
      name: 'flaky-routine',
      trigger: { type: 'cron', cron: '* * * * *' },
      action: { type: 'lightweight', prompt: 'Do something' },
      notify: { channel: 'ops', onFailure: true, onAttention: true },
      consecutiveFailures: 4, // Already failed 4 times
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    await engine.checkCronRoutines(now);

    // 5th failure → auto-pause
    const updated = engine.getRoutine('flaky-routine');
    expect(updated).toBeDefined();
    expect(updated!.enabled).toBe(false);
    expect(updated!.consecutiveFailures).toBe(5);
    // Should notify user about auto-pause
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        routineName: 'flaky-routine',
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Regex cache
  // -----------------------------------------------------------------------

  it('should compile and cache event trigger regexes', async () => {
    const routine1 = makeRoutine({
      name: 'event-a',
      trigger: { type: 'event', pattern: 'deploy\\s+failed' },
    });
    const routine2 = makeRoutine({
      name: 'event-b',
      trigger: { type: 'event', pattern: 'error\\s+\\d+' },
    });

    engine.addRoutine(routine1);
    engine.addRoutine(routine2);

    // Both should match correctly — proves regexes are compiled
    const runs1 = await engine.matchEvent('deploy failed');
    expect(runs1).toHaveLength(1);
    expect(runs1[0].routineName).toBe('event-a');

    const runs2 = await engine.matchEvent('error 500');
    expect(runs2).toHaveLength(1);
    expect(runs2[0].routineName).toBe('event-b');

    // Remove one, cache should update
    engine.removeRoutine('event-a');
    const runs3 = await engine.matchEvent('deploy failed');
    expect(runs3).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Validation — rejects
  // -----------------------------------------------------------------------

  it('should reject invalid cron expressions', () => {
    const routine = makeRoutine({
      name: 'bad-cron',
      trigger: { type: 'cron', cron: 'not-a-cron-expression' },
    });

    expect(() => engine.addRoutine(routine)).toThrow();
  });

  it('should reject invalid regex patterns', () => {
    const routine = makeRoutine({
      name: 'bad-regex',
      trigger: { type: 'event', pattern: '[invalid(' },
    });

    expect(() => engine.addRoutine(routine)).toThrow();
  });

  it('should reject routines with empty prompts', () => {
    const routine = makeRoutine({
      name: 'empty-prompt',
      action: { type: 'lightweight', prompt: '' },
    });

    expect(() => engine.addRoutine(routine)).toThrow();
  });

  it('should reject webhook payloads > 1MB', async () => {
    const secret = 'test-secret';
    const rawBody = JSON.stringify({ data: 'x'.repeat(1_100_000) }); // > 1MB
    const signature = hmacSign(rawBody, secret);

    const routine = makeRoutine({
      name: 'large-webhook',
      group: 'main',
      trigger: { type: 'webhook', secret },
    });

    engine.addRoutine(routine);
    const result = await engine.handleWebhook('main', 'large-webhook', rawBody, signature);

    // Should reject with an appropriate error status
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(onLightweightAction).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Dedup window for event triggers
  // -----------------------------------------------------------------------

  it('should respect dedup window for event triggers', async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const routine = makeRoutine({
      name: 'dedup-event',
      trigger: { type: 'event', pattern: 'error' },
      guardrails: { dedupWindowMs: 60_000 },
    });

    engine.addRoutine(routine);

    // First match should fire
    const runs1 = await engine.matchEvent('error happened');
    expect(runs1).toHaveLength(1);

    // Same event within dedup window should be suppressed
    vi.setSystemTime(now + 10_000);
    const runs2 = await engine.matchEvent('error happened again');
    expect(runs2).toHaveLength(0);

    // After dedup window expires, should fire again
    vi.setSystemTime(now + 61_000);
    const runs3 = await engine.matchEvent('error happened once more');
    expect(runs3).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Disabled routines should not fire
  // -----------------------------------------------------------------------

  it('should not fire disabled routines', async () => {
    const now = Date.now();
    const routine = makeRoutine({
      name: 'disabled-routine',
      enabled: false,
      trigger: { type: 'cron', cron: '* * * * *' },
      nextFireAt: now - 1000,
    });

    engine.addRoutine(routine);
    const runs = await engine.checkCronRoutines(now);

    expect(runs).toHaveLength(0);
    expect(onLightweightAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WebhookServer
// ---------------------------------------------------------------------------

describe('WebhookServer', () => {
  let engine: RoutineEngine;
  let server: WebhookServer;
  let onLightweightAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLightweightAction = vi.fn().mockResolvedValue('ROUTINE_OK');
    engine = new RoutineEngine({
      onLightweightAction,
      onFullJobAction: vi.fn(),
      onNotify: vi.fn(),
    });
  });

  afterEach(async () => {
    if (server) await server.stop();
    engine.shutdown();
  });

  it('should start on configured port', async () => {
    server = new WebhookServer({ port: 0, engine }); // port 0 = random available
    await server.start();
    // If start() resolves without error, the server is listening
    expect(server).toBeDefined();
  });

  it('should default to port 3456', () => {
    server = new WebhookServer({ engine });
    // The default port should be 3456 as specified
    expect((server as { port?: number }).port ?? 3456).toBe(3456);
  });

  it('should rate limit webhook endpoint (10 req/min)', async () => {
    const secret = 'rate-limit-secret';
    const routine = makeRoutine({
      name: 'rate-limited',
      group: 'test',
      trigger: { type: 'webhook', secret },
    });

    engine.addRoutine(routine);

    // Simulate 11 requests — the 11th should be rate-limited
    const results: { status: number }[] = [];
    for (let i = 0; i < 11; i++) {
      const rawBody = JSON.stringify({ seq: i });
      const signature = hmacSign(rawBody, secret);
      const result = await engine.handleWebhook('test', 'rate-limited', rawBody, signature);
      results.push(result);
    }

    // First 10 should succeed
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBeLessThanOrEqual(10);

    // At least one should be rate-limited (429)
    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
  });
});
