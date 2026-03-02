import crypto from 'node:crypto';
import http from 'node:http';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CRON_COOLDOWN_MS = 300_000; // 5 minutes — mandatory floor for cron routines
const MIN_EVENT_DEDUP_MS = 60_000; // 1 minute — mandatory floor for event routines
const MAX_DAILY_RUNS_DEFAULT = 50; // per-routine daily cap

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Trigger {
  type: 'cron' | 'event' | 'webhook';
  cron?: string;
  pattern?: string;
  channel?: string;
  secret?: string;
}

export interface RoutineAction {
  type: 'lightweight' | 'full_job';
  prompt: string;
  workspacePaths?: string[];
}

export interface RoutineGuardrails {
  cooldownMs?: number;
  maxConcurrent?: number;
  dedupWindowMs?: number;
  maxDailyRuns?: number;
}

export interface NotifyConfig {
  channel: string;
  onFailure?: boolean;
  onAttention?: boolean;
}

export interface Routine {
  name: string;
  group: string;
  trigger: Trigger;
  action: RoutineAction;
  guardrails: RoutineGuardrails;
  enabled: boolean;
  consecutiveFailures: number;
  nextFireAt?: number;
  lastRunAt?: number;
  notify?: NotifyConfig;
}

export interface RoutineRun {
  routineName: string;
  group: string;
  startedAt: number;
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

/** Validate a single cron field element against min/max range. */
function validateCronElement(
  value: string,
  min: number,
  max: number,
  field: string,
): void {
  // Handle step syntax: */N or N-M/S
  const stepParts = value.split('/');
  if (stepParts.length > 2) throw new Error(`Invalid cron field: ${field}`);

  const base = stepParts[0];
  if (stepParts.length === 2) {
    const step = parseInt(stepParts[1], 10);
    if (isNaN(step) || step < 1 || step > max) {
      throw new Error(`Invalid cron step value: ${field}`);
    }
  }

  if (base === '*') return;

  // Handle range: N-M
  if (base.includes('-')) {
    const [lo, hi] = base.split('-').map((n) => parseInt(n, 10));
    if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron range: ${field}`);
    }
    return;
  }

  // Plain number
  const num = parseInt(base, 10);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid cron field value: ${field}`);
  }
}

/** Validate a cron expression (5-field). Supports *, lists (,), ranges (-), steps (/). */
function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${parts.length} in "${expr}"`,
    );
  }
  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    // Handle comma-separated lists: 1,3,5 or 1-3,7-9
    const elements = field.split(',');
    for (const elem of elements) {
      validateCronElement(elem, ranges[i].min, ranges[i].max, field);
    }
  }
}

/** Compute next fire time from a cron expression (simple: uses first field step). */
function computeNextFireAt(cron: string, after: number): number {
  const parts = cron.trim().split(/\s+/);
  const minuteField = parts[0];

  // Default: 1-minute interval
  let intervalMs = 60_000;

  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    intervalMs = parseInt(stepMatch[1], 10) * 60_000;
  } else if (minuteField === '*') {
    intervalMs = 60_000;
  }

  return after + intervalMs;
}

// ---------------------------------------------------------------------------
// RoutineEngine
// ---------------------------------------------------------------------------

export interface RoutinePersistence {
  saveRoutine(routine: Routine): void;
  deleteRoutine(name: string): void;
  loadAllRoutines(): Routine[];
  logRun(run: RoutineRun): void;
}

interface RoutineEngineCallbacks {
  onLightweightAction: (action: RoutineAction) => Promise<string>;
  onFullJobAction: (action: RoutineAction) => Promise<unknown>;
  onNotify: (info: {
    routineName: string;
    group: string;
    message: string;
  }) => void;
  persistence?: RoutinePersistence;
}

export class RoutineEngine {
  private routines = new Map<string, Routine>();
  private regexCache = new Map<string, RegExp>();
  private runningCounts = new Map<string, number>();
  private lastEventFireAt = new Map<string, number>();
  private callbacks: RoutineEngineCallbacks;
  private rateLimitMap = new Map<string, number[]>();
  private dailyRunCounts = new Map<string, { date: string; count: number }>();
  private globalRunning = 0;
  private readonly MAX_GLOBAL_CONCURRENT = 5;

  constructor(callbacks: RoutineEngineCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Load all routines from the persistence layer (call at startup).
   */
  loadFromPersistence(): number {
    if (!this.callbacks.persistence) return 0;
    const routines = this.callbacks.persistence.loadAllRoutines();
    for (const routine of routines) {
      this.routines.set(routine.name, routine);
      // Rebuild regex cache for event-type routines
      if (routine.trigger.type === 'event' && routine.trigger.pattern) {
        try {
          this.regexCache.set(
            routine.name,
            new RegExp(routine.trigger.pattern),
          );
        } catch {
          // Invalid regex in DB — disable routine
          routine.enabled = false;
        }
      }
    }
    return routines.length;
  }

  // ---- CRUD ----

  addRoutine(routine: Routine): void {
    // Validate prompt
    if (!routine.action.prompt || routine.action.prompt.trim() === '') {
      throw new Error(`Routine "${routine.name}" has an empty prompt`);
    }

    // Validate trigger-specific fields
    if (routine.trigger.type === 'cron') {
      validateCron(routine.trigger.cron!);
      // Enforce minimum cooldown for cron routines (cost safety)
      if (
        !routine.guardrails.cooldownMs ||
        routine.guardrails.cooldownMs < MIN_CRON_COOLDOWN_MS
      ) {
        routine.guardrails.cooldownMs = MIN_CRON_COOLDOWN_MS;
      }
    }

    if (routine.trigger.type === 'event') {
      const pattern = routine.trigger.pattern!;
      // ReDoS guard: reject patterns with nested quantifiers or excessive length
      if (pattern.length > 200) {
        throw new Error(
          `Routine "${routine.name}" regex pattern exceeds 200 chars`,
        );
      }
      if (/(\+|\*|\{)\)?(\+|\*|\{)/.test(pattern)) {
        throw new Error(
          `Routine "${routine.name}" regex pattern contains nested quantifiers (ReDoS risk)`,
        );
      }
      try {
        const re = new RegExp(pattern);
        this.regexCache.set(routine.name, re);
      } catch {
        throw new Error(
          `Routine "${routine.name}" has invalid regex pattern: ${pattern}`,
        );
      }
      // Enforce minimum dedup window for event routines (cost safety)
      if (
        !routine.guardrails.dedupWindowMs ||
        routine.guardrails.dedupWindowMs < MIN_EVENT_DEDUP_MS
      ) {
        routine.guardrails.dedupWindowMs = MIN_EVENT_DEDUP_MS;
      }
    }

    // Set default daily run cap if not specified
    if (routine.guardrails.maxDailyRuns === undefined) {
      routine.guardrails.maxDailyRuns = MAX_DAILY_RUNS_DEFAULT;
    }

    const stored = { ...routine };
    this.routines.set(routine.name, stored);
    logger.debug(
      {
        routine: routine.name,
        group: routine.group,
        trigger: routine.trigger.type,
      },
      'Routine added',
    );

    // Persist to DB
    if (this.callbacks.persistence) {
      this.callbacks.persistence.saveRoutine(stored);
    }
  }

  removeRoutine(name: string): void {
    this.routines.delete(name);
    this.regexCache.delete(name);
    this.lastEventFireAt.delete(name);
    logger.debug({ routine: name }, 'Routine removed');

    // Remove from DB
    if (this.callbacks.persistence) {
      this.callbacks.persistence.deleteRoutine(name);
    }
  }

  getRoutine(name: string): Routine | undefined {
    const r = this.routines.get(name);
    return r ? { ...r } : undefined;
  }

  shutdown(): void {
    this.routines.clear();
    this.regexCache.clear();
    this.runningCounts.clear();
    this.lastEventFireAt.clear();
    this.rateLimitMap.clear();
    this.dailyRunCounts.clear();
  }

  // ---- Cron ----

  async checkCronRoutines(now: number): Promise<RoutineRun[]> {
    const runs: RoutineRun[] = [];

    for (const [, routine] of this.routines) {
      if (!routine.enabled) continue;
      if (routine.trigger.type !== 'cron') continue;
      if (routine.nextFireAt === undefined || routine.nextFireAt > now)
        continue;

      // Guardrails
      if (!this.passGuardrails(routine, now)) {
        // Update nextFireAt even if skipped so we don't re-check immediately
        routine.nextFireAt = computeNextFireAt(routine.trigger.cron!, now);
        continue;
      }

      const run = await this.executeRoutine(routine, now);
      runs.push(run);

      // Update nextFireAt
      routine.nextFireAt = computeNextFireAt(routine.trigger.cron!, now);
    }

    return runs;
  }

  // ---- Event ----

  async matchEvent(message: string, channel?: string): Promise<RoutineRun[]> {
    const runs: RoutineRun[] = [];
    const now = Date.now();

    for (const [name, routine] of this.routines) {
      if (!routine.enabled) continue;
      if (routine.trigger.type !== 'event') continue;

      // Channel filter
      if (routine.trigger.channel && channel !== routine.trigger.channel)
        continue;

      // Regex match
      const re = this.regexCache.get(name);
      if (!re || !re.test(message)) continue;

      // Dedup window guardrail
      if (routine.guardrails.dedupWindowMs) {
        const lastFire = this.lastEventFireAt.get(name);
        if (
          lastFire !== undefined &&
          now - lastFire < routine.guardrails.dedupWindowMs
        ) {
          continue;
        }
      }

      const run = await this.executeRoutine(routine, now);
      runs.push(run);

      this.lastEventFireAt.set(name, now);
    }

    return runs;
  }

  // ---- Webhook ----

  async handleWebhook(
    group: string,
    routineName: string,
    rawBody: string,
    signature: string,
  ): Promise<{ status: number; body?: string }> {
    // Rate limiting: 10 req/60s per group (with map size cap — Fix #6)
    const now = Date.now();
    if (this.rateLimitMap.size > 1000) {
      // Evict oldest entries to prevent unbounded growth
      const firstKey = this.rateLimitMap.keys().next().value;
      if (firstKey !== undefined) this.rateLimitMap.delete(firstKey);
    }
    if (!this.rateLimitMap.has(group)) {
      this.rateLimitMap.set(group, []);
    }
    const timestamps = this.rateLimitMap.get(group)!;
    // Prune old entries
    const windowStart = now - 60_000;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= 10) {
      return { status: 429, body: 'Rate limited' };
    }
    timestamps.push(now);

    // Payload size check on raw body (> 1MB)
    if (rawBody.length > 1_000_000) {
      return { status: 413, body: 'Payload too large' };
    }

    // Find routine
    const routine = this.routines.get(routineName);
    if (
      !routine ||
      routine.group !== group ||
      routine.trigger.type !== 'webhook'
    ) {
      return { status: 404, body: 'Routine not found' };
    }

    if (!routine.enabled) {
      return { status: 404, body: 'Routine disabled' };
    }

    // HMAC verification — computed on raw body bytes, not re-serialized JSON
    const secret = routine.trigger.secret;
    if (!secret) {
      return { status: 500, body: 'No webhook secret configured' };
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    // Timing-safe comparison to prevent byte-by-byte signature oracle (P0 fix)
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    if (
      expectedBuf.length !== signatureBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, signatureBuf)
    ) {
      return { status: 401, body: 'Invalid signature' };
    }

    // Execute
    await this.executeRoutine(routine, now);

    return { status: 200 };
  }

  // ---- Internal ----

  private passGuardrails(routine: Routine, now: number): boolean {
    const g = routine.guardrails;

    // Cooldown
    if (g.cooldownMs && routine.lastRunAt !== undefined) {
      if (now - routine.lastRunAt < g.cooldownMs) {
        return false;
      }
    }

    // Max concurrent
    if (g.maxConcurrent !== undefined) {
      const running = this.runningCounts.get(routine.name) ?? 0;
      if (running >= g.maxConcurrent) {
        return false;
      }
    }

    // Daily run cap
    if (g.maxDailyRuns !== undefined) {
      const today = new Date(now).toISOString().slice(0, 10);
      const dailyEntry = this.dailyRunCounts.get(routine.name);
      if (
        dailyEntry &&
        dailyEntry.date === today &&
        dailyEntry.count >= g.maxDailyRuns
      ) {
        return false;
      }
    }

    return true;
  }

  private async executeRoutine(
    routine: Routine,
    now: number,
  ): Promise<RoutineRun> {
    const run: RoutineRun = {
      routineName: routine.name,
      group: routine.group,
      startedAt: now,
    };

    // Global concurrency cap (P1 fix — prevents cost spiral from many routines)
    if (this.globalRunning >= this.MAX_GLOBAL_CONCURRENT) {
      run.error = 'Global concurrency limit reached';
      logger.warn(
        { routine: routine.name, globalRunning: this.globalRunning },
        'Routine skipped — global concurrency limit',
      );
      return run;
    }
    this.globalRunning++;

    // Track per-routine concurrency
    const currentRunning = this.runningCounts.get(routine.name) ?? 0;
    this.runningCounts.set(routine.name, currentRunning + 1);

    // Track daily runs
    const today = new Date(now).toISOString().slice(0, 10);
    const dailyEntry = this.dailyRunCounts.get(routine.name);
    if (dailyEntry && dailyEntry.date === today) {
      dailyEntry.count++;
    } else {
      this.dailyRunCounts.set(routine.name, { date: today, count: 1 });
    }

    try {
      if (routine.action.type === 'lightweight') {
        const result = await this.callbacks.onLightweightAction(routine.action);
        run.result = result;

        // Reset consecutive failures on success
        routine.consecutiveFailures = 0;
        routine.lastRunAt = now;

        // Notification logic
        if (result !== 'ROUTINE_OK' && routine.notify) {
          if (
            (routine.notify.onAttention && result.startsWith('ATTENTION:')) ||
            (routine.notify.onFailure && result.startsWith('FAILURE:'))
          ) {
            this.callbacks.onNotify({
              routineName: routine.name,
              group: routine.group,
              message: result,
            });
          }
        }
      } else if (routine.action.type === 'full_job') {
        await this.callbacks.onFullJobAction(routine.action);
        routine.consecutiveFailures = 0;
        routine.lastRunAt = now;
      }
    } catch (err) {
      routine.consecutiveFailures += 1;
      routine.lastRunAt = now;
      run.error = err instanceof Error ? err.message : String(err);

      // Notify on failure
      if (routine.notify?.onFailure) {
        this.callbacks.onNotify({
          routineName: routine.name,
          group: routine.group,
          message: `Routine failed: ${run.error}`,
        });
      }

      // Auto-pause after 5 consecutive failures
      if (routine.consecutiveFailures >= 5) {
        routine.enabled = false;
        logger.warn(
          { routine: routine.name, failures: routine.consecutiveFailures },
          'Routine auto-paused',
        );
        this.callbacks.onNotify({
          routineName: routine.name,
          group: routine.group,
          message: `Auto-paused after ${routine.consecutiveFailures} consecutive failures`,
        });
      }
    } finally {
      this.globalRunning--;
      const count = this.runningCounts.get(routine.name) ?? 1;
      this.runningCounts.set(routine.name, Math.max(0, count - 1));

      // Persist routine state changes and run log
      if (this.callbacks.persistence) {
        this.callbacks.persistence.saveRoutine(routine);
        this.callbacks.persistence.logRun(run);
      }
    }

    return run;
  }
}

// ---------------------------------------------------------------------------
// WebhookServer
// ---------------------------------------------------------------------------

interface WebhookServerOptions {
  port?: number;
  engine: RoutineEngine;
}

export class WebhookServer {
  private port: number;
  private engine: RoutineEngine;
  private server: http.Server | null = null;

  constructor(options: WebhookServerOptions) {
    const port = options.port ?? 3456;
    if (port !== 0 && (port < 1024 || port > 65535)) {
      throw new Error(
        `Webhook port must be 0 (OS-assigned) or between 1024 and 65535, got ${port}`,
      );
    }
    this.port = port;
    this.engine = options.engine;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Only handle POST to /webhooks/{group}/{routine_name}
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        const match = req.url?.match(/^\/webhooks\/([^/]+)\/([^/]+)$/);
        if (!match) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // URL-decode and validate path params (Fix #5 — prevent encoded traversal)
        let group: string;
        let routineName: string;
        try {
          group = decodeURIComponent(match[1]);
          routineName = decodeURIComponent(match[2]);
        } catch {
          res.writeHead(400);
          res.end('Invalid URL encoding');
          return;
        }
        if (
          !/^[A-Za-z0-9_-]+$/.test(group) ||
          !/^[A-Za-z0-9_-]+$/.test(routineName)
        ) {
          res.writeHead(400);
          res.end('Invalid group or routine name');
          return;
        }

        // Read body
        const chunks: Buffer[] = [];
        let bodySize = 0;
        for await (const chunk of req) {
          bodySize += (chunk as Buffer).length;
          if (bodySize > 1_100_000) {
            res.writeHead(413);
            res.end('Payload too large');
            return;
          }
          chunks.push(chunk as Buffer);
        }

        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          JSON.parse(bodyStr); // Validate JSON — reject garbage early
          const signature = (req.headers['x-signature'] as string) ?? '';

          const result = await this.engine.handleWebhook(
            group,
            routineName,
            bodyStr,
            signature,
          );
          res.writeHead(result.status);
          res.end(result.body ?? '');
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
