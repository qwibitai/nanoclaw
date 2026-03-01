import crypto from 'node:crypto';
import http from 'node:http';

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

/** Validate a cron expression (5-field). Throws on invalid. */
function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length} in "${expr}"`);
  }
  // Basic field validation
  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    if (field === '*') continue;
    // Handle */N step syntax
    const stepMatch = field.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step < 1 || step > ranges[i].max) {
        throw new Error(`Invalid cron step value: ${field}`);
      }
      continue;
    }
    // Handle plain number
    const num = parseInt(field, 10);
    if (isNaN(num) || num < ranges[i].min || num > ranges[i].max) {
      throw new Error(`Invalid cron field value: ${field}`);
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

interface RoutineEngineCallbacks {
  onLightweightAction: (action: RoutineAction) => Promise<string>;
  onFullJobAction: (action: RoutineAction) => Promise<unknown>;
  onNotify: (info: { routineName: string; group: string; message: string }) => void;
}

export class RoutineEngine {
  private routines = new Map<string, Routine>();
  private regexCache = new Map<string, RegExp>();
  private runningCounts = new Map<string, number>();
  private lastEventFireAt = new Map<string, number>();
  private callbacks: RoutineEngineCallbacks;
  private rateLimitMap = new Map<string, number[]>();
  private globalRunning = 0;
  private readonly MAX_GLOBAL_CONCURRENT = 5;

  constructor(callbacks: RoutineEngineCallbacks) {
    this.callbacks = callbacks;
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
    }

    if (routine.trigger.type === 'event') {
      try {
        const re = new RegExp(routine.trigger.pattern!);
        this.regexCache.set(routine.name, re);
      } catch {
        throw new Error(
          `Routine "${routine.name}" has invalid regex pattern: ${routine.trigger.pattern}`,
        );
      }
    }

    this.routines.set(routine.name, { ...routine });
  }

  removeRoutine(name: string): void {
    this.routines.delete(name);
    this.regexCache.delete(name);
    this.lastEventFireAt.delete(name);
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
  }

  // ---- Cron ----

  async checkCronRoutines(now: number): Promise<RoutineRun[]> {
    const runs: RoutineRun[] = [];

    for (const [name, routine] of this.routines) {
      if (!routine.enabled) continue;
      if (routine.trigger.type !== 'cron') continue;
      if (routine.nextFireAt === undefined || routine.nextFireAt > now) continue;

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
      if (routine.trigger.channel && channel !== routine.trigger.channel) continue;

      // Regex match
      const re = this.regexCache.get(name);
      if (!re || !re.test(message)) continue;

      // Dedup window guardrail
      if (routine.guardrails.dedupWindowMs) {
        const lastFire = this.lastEventFireAt.get(name);
        if (lastFire !== undefined && now - lastFire < routine.guardrails.dedupWindowMs) {
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
    payload: unknown,
    signature: string,
  ): Promise<{ status: number; body?: string }> {
    // Rate limiting: 10 req/60s per group
    const now = Date.now();
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

    // Payload size check (> 1MB)
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 1_000_000) {
      return { status: 413, body: 'Payload too large' };
    }

    // Find routine
    const routine = this.routines.get(routineName);
    if (!routine || routine.group !== group || routine.trigger.type !== 'webhook') {
      return { status: 404, body: 'Routine not found' };
    }

    if (!routine.enabled) {
      return { status: 404, body: 'Routine disabled' };
    }

    // HMAC verification
    const secret = routine.trigger.secret;
    if (!secret) {
      return { status: 500, body: 'No webhook secret configured' };
    }
    const expected = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    // Timing-safe comparison to prevent byte-by-byte signature oracle (P0 fix)
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== signatureBuf.length || !crypto.timingSafeEqual(expectedBuf, signatureBuf)) {
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

    return true;
  }

  private async executeRoutine(routine: Routine, now: number): Promise<RoutineRun> {
    const run: RoutineRun = {
      routineName: routine.name,
      group: routine.group,
      startedAt: now,
    };

    // Global concurrency cap (P1 fix — prevents cost spiral from many routines)
    if (this.globalRunning >= this.MAX_GLOBAL_CONCURRENT) {
      run.error = 'Global concurrency limit reached';
      return run;
    }
    this.globalRunning++;

    // Track per-routine concurrency
    const currentRunning = this.runningCounts.get(routine.name) ?? 0;
    this.runningCounts.set(routine.name, currentRunning + 1);

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
    this.port = options.port ?? 3456;
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

        const [, group, routineName] = match;

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
          const payload = JSON.parse(bodyStr);
          const signature = (req.headers['x-signature'] as string) ?? '';

          const result = await this.engine.handleWebhook(group, routineName, payload, signature);
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
