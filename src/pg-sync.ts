/**
 * pg-sync.ts — Fire-and-forget PostgreSQL sync layer
 *
 * Strategy: nanoclaw keeps SQLite as the sync read/write source (zero
 * breaking changes). Every write to a "dashboard-visible" table is also
 * mirrored to PostgreSQL asynchronously. If PG is unavailable the bot
 * continues working — SQLite is the source of truth for nanoclaw.
 *
 * Tables synced (PostgreSQL is the source of truth for the dashboard):
 *   registered_groups, conversation_sessions, router_state,
 *   scheduled_tasks, task_run_logs
 *
 * Tables NOT synced (nanoclaw-internal hot path):
 *   chats, messages  — high volume, sync-only, no dashboard value
 */

import pg from 'pg';
import { logger } from './logger.js';

let pool: pg.Pool | null = null;

export function initPgSync(databaseUrl: string): void {
  try {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    pool.on('error', (err) => {
      logger.warn({ err }, 'pg-sync: pool error (non-fatal)');
    });
    logger.info('pg-sync: PostgreSQL sync pool initialised');
  } catch (err) {
    logger.warn({ err }, 'pg-sync: failed to init pool — dashboard sync disabled');
    pool = null;
  }
}

function run(fn: (client: pg.PoolClient) => Promise<void>): void {
  if (!pool) return;
  pool.connect().then(client => {
    fn(client)
      .catch(err => logger.warn({ err }, 'pg-sync: write failed (non-fatal)'))
      .finally(() => client.release());
  }).catch(err => logger.warn({ err }, 'pg-sync: connect failed (non-fatal)'));
}

// ─── registered_groups ────────────────────────────────────────────────────────

export function pgSyncSetRegisteredGroup(
  jid: string,
  name: string,
  folder: string,
  triggerPattern: string,
  addedAt: string,
  containerConfig: object | null,
  requiresTrigger: boolean,
  isMain: boolean,
): void {
  run(async (client) => {
    await client.query(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (jid) DO UPDATE SET
         name = EXCLUDED.name,
         folder = EXCLUDED.folder,
         trigger_pattern = EXCLUDED.trigger_pattern,
         container_config = EXCLUDED.container_config,
         requires_trigger = EXCLUDED.requires_trigger,
         is_main = EXCLUDED.is_main`,
      [jid, name, folder, triggerPattern, new Date(addedAt),
       containerConfig ? JSON.stringify(containerConfig) : null,
       requiresTrigger, isMain],
    );
  });
}

// ─── conversation_sessions ────────────────────────────────────────────────────

export function pgSyncSetSession(groupFolder: string, sessionId: string): void {
  run(async (client) => {
    await client.query(
      `INSERT INTO conversation_sessions (group_folder, session_id)
       VALUES ($1,$2)
       ON CONFLICT (group_folder) DO UPDATE SET session_id = EXCLUDED.session_id`,
      [groupFolder, sessionId],
    );
  });
}

// ─── router_state ─────────────────────────────────────────────────────────────

export function pgSyncSetRouterState(key: string, value: string): void {
  run(async (client) => {
    await client.query(
      `INSERT INTO router_state (key, value)
       VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  });
}

// ─── scheduled_tasks ─────────────────────────────────────────────────────────

export function pgSyncCreateTask(task: {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  status: string;
  created_at: string;
}): void {
  run(async (client) => {
    await client.query(
      `INSERT INTO scheduled_tasks
         (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [task.id, task.group_folder, task.chat_jid, task.prompt,
       task.schedule_type, task.schedule_value, task.context_mode,
       task.next_run ? new Date(task.next_run) : null,
       task.status, new Date(task.created_at)],
    );
  });
}

export function pgSyncUpdateTask(
  id: string,
  updates: { prompt?: string; schedule_type?: string; schedule_value?: string; next_run?: string | null; status?: string },
): void {
  run(async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (updates.prompt !== undefined)         { fields.push(`prompt = $${i++}`);         values.push(updates.prompt); }
    if (updates.schedule_type !== undefined)  { fields.push(`schedule_type = $${i++}`);  values.push(updates.schedule_type); }
    if (updates.schedule_value !== undefined) { fields.push(`schedule_value = $${i++}`); values.push(updates.schedule_value); }
    if (updates.next_run !== undefined)       { fields.push(`next_run = $${i++}`);        values.push(updates.next_run ? new Date(updates.next_run) : null); }
    if (updates.status !== undefined)         { fields.push(`status = $${i++}`);          values.push(updates.status); }
    if (fields.length === 0) return;

    values.push(id);
    await client.query(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${i}`, values);
  });
}

export function pgSyncUpdateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  run(async (client) => {
    await client.query(
      `UPDATE scheduled_tasks
       SET next_run = $1, last_run = NOW(), last_result = $2,
           status = CASE WHEN $1 IS NULL THEN 'completed' ELSE status END
       WHERE id = $3`,
      [nextRun ? new Date(nextRun) : null, lastResult, id],
    );
  });
}

export function pgSyncDeleteTask(id: string): void {
  run(async (client) => {
    await client.query('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
    await client.query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
  });
}

// ─── task_run_logs ────────────────────────────────────────────────────────────

export function pgSyncLogTaskRun(log: {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}): void {
  run(async (client) => {
    await client.query(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [log.task_id, new Date(log.run_at), log.duration_ms,
       log.status, log.result, log.error],
    );
  });
}

export function closePgSync(): void {
  pool?.end().catch(() => {});
  pool = null;
}
