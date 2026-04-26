/**
 * Step: migrate-tasks
 *
 * Port v1's `scheduled_tasks` into v2's session inbound DBs. v1 had a
 * dedicated table with its own scheduling grammar; v2 treats tasks as
 * `messages_in` rows with `kind='task'`, `process_after`, and `recurrence`
 * (cron string). See docs/v1-to-v2-changes.md "Scheduling".
 *
 * Flow per v1 row:
 *   1. Resolve (agent_group_id, messaging_group_id) from v1 (group_folder, chat_jid)
 *   2. resolveSession() — creates the session on demand if absent
 *   3. insertTask() into the session's inbound.db
 *
 * Active v1 rows (status='active') are migrated. Completed/stopped rows get
 * exported to logs/setup-migration/inactive-tasks.json for reference.
 *
 * v1's schedule_type / schedule_value are mapped to cron here. Known types:
 *   'cron'     → schedule_value is already a cron string
 *   'interval' → e.g. '5m'/'1h' → cron equivalent (best effort)
 *   'once'     → no recurrence, process_after = schedule_value if parseable
 * Unknown types go to inactive-tasks.json with a note.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/connection.js';
import { getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { log } from '../../src/log.js';
import { insertTask } from '../../src/modules/scheduling/db.js';
import { openInboundDb, resolveSession } from '../../src/session-manager.js';
import { emitStatus } from '../status.js';
import {
  INACTIVE_TASKS_PATH,
  MIGRATION_DIR,
  inferChannelType,
  readHandoff,
  recordStep,
  safeJsonStringify,
  v1PathsFor,
  v2PlatformId,
  writeHandoff,
} from './shared.js';

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  status: string;
  context_mode: string | null;
  script: string | null;
}

/** Convert v1 schedule_type + schedule_value into (processAfter, recurrence). */
function toProcessAfterAndRecurrence(t: V1Task): {
  processAfter: string;
  recurrence: string | null;
  note?: string;
} | null {
  const now = new Date().toISOString();

  if (t.schedule_type === 'cron') {
    // Validate shape — 5 or 6 fields separated by whitespace. cron-parser is
    // the runtime source of truth; here we just reject obvious garbage so
    // we don't insert tasks that will explode on the first sweep tick.
    const fields = t.schedule_value.trim().split(/\s+/).length;
    if (fields < 5 || fields > 6) return null;
    return {
      processAfter: t.next_run || now,
      recurrence: t.schedule_value.trim(),
    };
  }

  if (t.schedule_type === 'interval') {
    // '5m' → '*/5 * * * *'; '1h' → '0 * * * *'; '1d' → '0 0 * * *'.
    // Best effort — any unit we don't recognize falls through to null.
    const m = /^(\d+)([smhd])$/.exec(t.schedule_value.trim());
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (!n || n < 1) return null;
    let cron: string | null = null;
    if (unit === 'm' && n < 60) cron = `*/${n} * * * *`;
    else if (unit === 'h' && n < 24) cron = `0 */${n} * * *`;
    else if (unit === 'd' && n < 28) cron = `0 0 */${n} * *`;
    if (!cron) return null;
    return { processAfter: t.next_run || now, recurrence: cron };
  }

  if (t.schedule_type === 'once' || t.schedule_type === 'at') {
    return {
      processAfter: t.next_run || t.schedule_value || now,
      recurrence: null,
    };
  }

  return null;
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-tasks', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_TASKS', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const validate = h.steps['migrate-validate'];
  if (validate && validate.status === 'failed') {
    recordStep('migrate-tasks', {
      status: 'skipped',
      fields: { REASON: 'validate-failed' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_TASKS', { STATUS: 'skipped', REASON: 'validate_failed' });
    return;
  }

  const paths = v1PathsFor(h.v1_path);

  // Read v1 tasks into memory so we can close the v1 DB before we open v2's
  // central DB via initDb() (which is a module singleton and doesn't love
  // having two files open through it).
  let activeTasks: V1Task[] = [];
  let inactiveTasks: V1Task[] = [];
  try {
    const v1Db = new Database(paths.db, { readonly: true, fileMustExist: true });
    const all = v1Db.prepare('SELECT * FROM scheduled_tasks').all() as V1Task[];
    v1Db.close();
    activeTasks = all.filter((t) => t.status === 'active');
    inactiveTasks = all.filter((t) => t.status !== 'active');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordStep('migrate-tasks', {
      status: 'failed',
      fields: { REASON: 'v1-read-failed' },
      notes: [message],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_TASKS', { STATUS: 'failed', REASON: 'v1_read_failed', ERROR: message });
    return;
  }

  if (activeTasks.length === 0 && inactiveTasks.length === 0) {
    recordStep('migrate-tasks', {
      status: 'skipped',
      fields: { REASON: 'no-v1-tasks' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_TASKS', { STATUS: 'skipped', REASON: 'no_v1_tasks' });
    return;
  }

  // Dump inactive tasks for reference — always, even if there are no active ones.
  if (inactiveTasks.length > 0) {
    fs.mkdirSync(MIGRATION_DIR, { recursive: true });
    fs.writeFileSync(INACTIVE_TASKS_PATH, safeJsonStringify({ tasks: inactiveTasks }));
  }

  // Connect to v2 central DB to resolve (folder → ag) and (channel+pid → mg).
  const v2Path = path.join(DATA_DIR, 'v2.db');
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  const v2Db = initDb(v2Path);
  runMigrations(v2Db);

  const followups: string[] = [];
  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of activeTasks) {
    try {
      const ag = getAgentGroupByFolder(t.group_folder);
      if (!ag) {
        skipped += 1;
        followups.push(
          `Task "${t.id}" (folder "${t.group_folder}"): agent_group not seeded in v2 — run migrate-db first or deselect the task.`,
        );
        continue;
      }

      const channelType = inferChannelType(t.chat_jid, null);
      if (!channelType) {
        skipped += 1;
        followups.push(`Task "${t.id}": could not infer channel from chat_jid "${t.chat_jid}".`);
        continue;
      }
      const platformId = v2PlatformId(channelType, t.chat_jid);
      const mg = getMessagingGroupByPlatform(channelType, platformId);
      if (!mg) {
        skipped += 1;
        followups.push(
          `Task "${t.id}": messaging_group for (${channelType}, ${platformId}) not seeded. Add the channel then re-run this step.`,
        );
        continue;
      }

      const scheduling = toProcessAfterAndRecurrence(t);
      if (!scheduling) {
        skipped += 1;
        followups.push(
          `Task "${t.id}": schedule_type "${t.schedule_type}" / value "${t.schedule_value}" did not map to a v2 cron — exported to inactive-tasks.json for manual review.`,
        );
        inactiveTasks.push(t);
        continue;
      }

      // resolveSession creates (ag, mg) session if not present; 'shared' mode
      // matches v1 which had one session per group_folder.
      const { session } = resolveSession(ag.id, mg.id, null, 'shared');
      const inboxDb = openInboundDb(ag.id, session.id);
      try {
        // Idempotence: skip if we've already migrated this task id. We use the
        // v1 task id verbatim as the v2 messages_in.id (stable — lets users
        // re-run migration without duplicate-key errors or shadow tasks).
        const existing = inboxDb
          .prepare("SELECT id FROM messages_in WHERE id = ? AND kind = 'task'")
          .get(t.id) as { id: string } | undefined;
        if (existing) {
          skipped += 1;
          continue;
        }

        insertTask(inboxDb, {
          id: t.id,
          processAfter: scheduling.processAfter,
          recurrence: scheduling.recurrence,
          platformId,
          channelType,
          threadId: null,
          content: JSON.stringify({
            prompt: t.prompt,
            script: t.script ?? null,
            migrated_from_v1: { original_id: t.id, context_mode: t.context_mode ?? null },
          }),
        });
      } finally {
        inboxDb.close();
      }

      log.info('Migrated v1 scheduled task', { taskId: t.id, session: session.id, mg: mg.id });
      migrated += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      followups.push(`Task "${t.id}" failed to migrate: ${message}`);
    }
  }

  // Re-dump inactive tasks in case scheduling-translation pushed any in.
  if (inactiveTasks.length > 0) {
    fs.writeFileSync(INACTIVE_TASKS_PATH, safeJsonStringify({ tasks: inactiveTasks }));
  }

  closeDb();

  const handoffAfter = readHandoff();
  handoffAfter.tasks = {
    v1_active: activeTasks.length,
    v1_inactive: inactiveTasks.length,
    migrated,
    failed,
    skipped,
  };
  handoffAfter.followups = [...new Set([...handoffAfter.followups, ...followups])];
  writeHandoff(handoffAfter);

  const partial = failed > 0 || skipped > 0;
  recordStep('migrate-tasks', {
    status: failed > 0 ? 'partial' : partial ? 'partial' : 'success',
    fields: {
      V1_ACTIVE: activeTasks.length,
      V1_INACTIVE: inactiveTasks.length,
      MIGRATED: migrated,
      FAILED: failed,
      SKIPPED: skipped,
      INACTIVE_EXPORT: inactiveTasks.length > 0 ? INACTIVE_TASKS_PATH : '',
    },
    notes: followups,
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_TASKS', {
    STATUS: partial ? 'partial' : 'success',
    V1_ACTIVE: String(activeTasks.length),
    V1_INACTIVE: String(inactiveTasks.length),
    MIGRATED: String(migrated),
    FAILED: String(failed),
    SKIPPED: String(skipped),
  });
}
