import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  BehavioralSkill,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  SkillEvaluation,
  SkillPerformance,
  SkillTaskRun,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    -- Behavioral skills
    CREATE TABLE IF NOT EXISTS behavioral_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      description TEXT NOT NULL,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      group_folder TEXT,
      FOREIGN KEY (parent_id) REFERENCES behavioral_skills(id)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_status ON behavioral_skills(status);
    CREATE INDEX IF NOT EXISTS idx_skills_name ON behavioral_skills(name, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_version ON behavioral_skills(name, group_folder, version);

    CREATE TABLE IF NOT EXISTS skill_task_runs (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt_summary TEXT,
      response_summary TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      evaluation_deadline TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skill_runs_deadline ON skill_task_runs(evaluation_deadline);

    CREATE TABLE IF NOT EXISTS skill_run_selections (
      run_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      PRIMARY KEY (run_id, skill_id),
      FOREIGN KEY (run_id) REFERENCES skill_task_runs(id),
      FOREIGN KEY (skill_id) REFERENCES behavioral_skills(id)
    );

    CREATE TABLE IF NOT EXISTS skill_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      score REAL NOT NULL,
      dimensions TEXT,
      evaluation_source TEXT NOT NULL,
      raw_feedback TEXT,
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES skill_task_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_eval_run ON skill_evaluations(run_id);

    CREATE TABLE IF NOT EXISTS skill_performance (
      skill_id TEXT PRIMARY KEY,
      total_runs INTEGER NOT NULL DEFAULT 0,
      avg_score REAL NOT NULL DEFAULT 0.0,
      recent_avg_score REAL NOT NULL DEFAULT 0.0,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES behavioral_skills(id)
    );

    CREATE TABLE IF NOT EXISTS skill_evolution_log (
      id TEXT PRIMARY KEY,
      group_folder TEXT,
      action TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      changes_summary TEXT,
      trigger_reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Behavioral skills accessors ---

export function getActiveSkills(
  groupFolder?: string | null,
): BehavioralSkill[] {
  return db
    .prepare(
      `SELECT * FROM behavioral_skills
       WHERE status IN ('active', 'candidate')
         AND (group_folder IS NULL OR group_folder = ?)
       ORDER BY name`,
    )
    .all(groupFolder ?? null) as BehavioralSkill[];
}

export function getSkillByName(
  name: string,
  groupFolder?: string | null,
): BehavioralSkill | undefined {
  return db
    .prepare(
      `SELECT * FROM behavioral_skills
       WHERE name = ? AND status = 'active'
         AND (group_folder IS NULL OR group_folder = ?)
       ORDER BY version DESC LIMIT 1`,
    )
    .get(name, groupFolder ?? null) as BehavioralSkill | undefined;
}

export function getSkillById(id: string): BehavioralSkill | undefined {
  return db
    .prepare('SELECT * FROM behavioral_skills WHERE id = ?')
    .get(id) as BehavioralSkill | undefined;
}

export function insertSkill(skill: BehavioralSkill): void {
  db.prepare(
    `INSERT INTO behavioral_skills (id, name, version, content, description, parent_id, status, created_at, group_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    skill.id,
    skill.name,
    skill.version,
    skill.content,
    skill.description,
    skill.parent_id,
    skill.status,
    skill.created_at,
    skill.group_folder,
  );
}

export function updateSkillStatus(
  id: string,
  status: BehavioralSkill['status'],
): void {
  db.prepare('UPDATE behavioral_skills SET status = ? WHERE id = ?').run(
    status,
    id,
  );
}

export function recordSkillTaskRun(run: SkillTaskRun): void {
  db.prepare(
    `INSERT INTO skill_task_runs (id, group_folder, chat_jid, prompt_summary, response_summary, duration_ms, status, created_at, evaluation_deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.group_folder,
    run.chat_jid,
    run.prompt_summary,
    run.response_summary,
    run.duration_ms,
    run.status,
    run.created_at,
    run.evaluation_deadline,
  );
}

export function getTaskRun(id: string): SkillTaskRun | undefined {
  return db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get(id) as
    | SkillTaskRun
    | undefined;
}

export function recordSkillSelections(
  runId: string,
  skillIds: string[],
): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO skill_run_selections (run_id, skill_id) VALUES (?, ?)',
  );
  for (const skillId of skillIds) {
    stmt.run(runId, skillId);
  }
}

export function getRunsNeedingEvaluation(): SkillTaskRun[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT r.* FROM skill_task_runs r
       LEFT JOIN skill_evaluations e ON e.run_id = r.id
       WHERE r.evaluation_deadline IS NOT NULL
         AND r.evaluation_deadline <= ?
         AND e.id IS NULL
       ORDER BY r.created_at`,
    )
    .all(now) as SkillTaskRun[];
}

export function recordEvaluation(evaluation: SkillEvaluation): void {
  db.prepare(
    `INSERT INTO skill_evaluations (id, run_id, score, dimensions, evaluation_source, raw_feedback, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evaluation.id,
    evaluation.run_id,
    evaluation.score,
    evaluation.dimensions,
    evaluation.evaluation_source,
    evaluation.raw_feedback,
    evaluation.evaluated_at,
  );
}

export function getEvaluationForRun(
  runId: string,
): SkillEvaluation | undefined {
  return db
    .prepare('SELECT * FROM skill_evaluations WHERE run_id = ?')
    .get(runId) as SkillEvaluation | undefined;
}

export function updateSkillPerformance(skillId: string): void {
  const now = new Date().toISOString();

  // Calculate avg score from all evaluations where this skill was used
  const stats = db
    .prepare(
      `SELECT COUNT(*) as total, AVG(e.score) as avg_score
       FROM skill_evaluations e
       JOIN skill_run_selections s ON s.run_id = e.run_id
       WHERE s.skill_id = ?`,
    )
    .get(skillId) as { total: number; avg_score: number | null };

  // Recent average (last 10 evaluations)
  const recent = db
    .prepare(
      `SELECT AVG(e.score) as recent_avg
       FROM (
         SELECT e.score FROM skill_evaluations e
         JOIN skill_run_selections s ON s.run_id = e.run_id
         WHERE s.skill_id = ?
         ORDER BY e.evaluated_at DESC LIMIT 10
       ) e`,
    )
    .get(skillId) as { recent_avg: number | null };

  db.prepare(
    `INSERT INTO skill_performance (skill_id, total_runs, avg_score, recent_avg_score, last_updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       total_runs = excluded.total_runs,
       avg_score = excluded.avg_score,
       recent_avg_score = excluded.recent_avg_score,
       last_updated = excluded.last_updated`,
  ).run(
    skillId,
    stats.total,
    stats.avg_score ?? 0,
    recent.recent_avg ?? 0,
    now,
  );
}

export function getSkillPerformance(
  skillId: string,
): SkillPerformance | undefined {
  return db
    .prepare('SELECT * FROM skill_performance WHERE skill_id = ?')
    .get(skillId) as SkillPerformance | undefined;
}

export function getAllSkillPerformance(): SkillPerformance[] {
  return db.prepare('SELECT * FROM skill_performance').all() as SkillPerformance[];
}

export function getSkillSelectionsForRun(runId: string): string[] {
  const rows = db
    .prepare('SELECT skill_id FROM skill_run_selections WHERE run_id = ?')
    .all(runId) as Array<{ skill_id: string }>;
  return rows.map((r) => r.skill_id);
}

export function getRecentEvaluationCount(sinceTimestamp: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM skill_evaluations WHERE evaluated_at > ?',
    )
    .get(sinceTimestamp) as { cnt: number };
  return row.cnt;
}

export function getLowScoringRuns(
  minRuns: number,
  maxScore: number,
  limit: number = 20,
): Array<SkillTaskRun & { score: number; dimensions: string | null }> {
  return db
    .prepare(
      `SELECT r.*, e.score, e.dimensions
       FROM skill_task_runs r
       JOIN skill_evaluations e ON e.run_id = r.id
       WHERE e.score < ?
       ORDER BY e.score ASC
       LIMIT ?`,
    )
    .all(maxScore, limit) as Array<
    SkillTaskRun & { score: number; dimensions: string | null }
  >;
}

export function insertEvolutionLog(log: {
  id: string;
  group_folder: string | null;
  action: string;
  skill_id: string;
  changes_summary: string | null;
  trigger_reason: string;
  created_at: string;
}): void {
  db.prepare(
    `INSERT INTO skill_evolution_log (id, group_folder, action, skill_id, changes_summary, trigger_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    log.id,
    log.group_folder,
    log.action,
    log.skill_id,
    log.changes_summary,
    log.trigger_reason,
    log.created_at,
  );
}

export function getLastEvolutionTimestamp(): string | null {
  const row = db
    .prepare(
      'SELECT created_at FROM skill_evolution_log ORDER BY created_at DESC LIMIT 1',
    )
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function getSkillVersionCount(
  name: string,
  groupFolder: string | null,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM behavioral_skills WHERE name = ? AND (group_folder IS NULL AND ? IS NULL OR group_folder = ?)',
    )
    .get(name, groupFolder, groupFolder) as { cnt: number };
  return row.cnt;
}

export function getTotalEvaluatedRuns(): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM skill_evaluations')
    .get() as { cnt: number };
  return row.cnt;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
