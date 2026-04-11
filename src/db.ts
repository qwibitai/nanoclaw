import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { VALID_GROUP_TYPES } from './group-type.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  ContainerConfig,
  GroupType,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  ThreadDefaults,
} from './types.js';

/** DB の group_type / is_main から GroupType を解決する */
function parseGroupType(
  groupType: string | null,
  isMain: number | null,
  jid?: string,
): GroupType {
  if (groupType == null) {
    // NULL はレガシー DB → is_main フォールバック
    return isMain === 1 ? 'main' : 'chat';
  }
  if (VALID_GROUP_TYPES.has(groupType)) {
    return groupType as GroupType;
  }
  // 不正な文字列は is_main を無視して 'chat' にフォールバック
  logger.warn(
    { jid, groupType },
    'Invalid group_type in DB; falling back to "chat".',
  );
  return 'chat';
}

const JID_PREFIX_RE = /^[a-z]{2,}:/;
const WHATSAPP_JID_RE = /^[^@\s]+@(g\.us|s\.whatsapp\.net)$/;
const SPAWNED_THREAD_RETENTION_DAYS = 30;
const PENDING_SPAWN_THREAD_JID = '__pending__';

export function _shouldMigrateSessionKey(key: string): boolean {
  if (JID_PREFIX_RE.test(key)) return true;
  if (WHATSAPP_JID_RE.test(key)) return true;
  return false;
}

export function _sanitizeContainerConfig(
  raw: unknown,
  jid: string,
  field:
    | 'container_config'
    | 'thread_defaults.containerConfig' = 'container_config',
): ContainerConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn({ jid, field }, 'Invalid containerConfig; ignoring');
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const out: ContainerConfig = {};
  if (Object.prototype.hasOwnProperty.call(src, 'timeout')) {
    if (
      typeof src.timeout === 'number' &&
      Number.isFinite(src.timeout) &&
      src.timeout > 0
    ) {
      out.timeout = src.timeout;
    } else {
      logger.warn(
        { jid, field, timeout: src.timeout },
        'Invalid containerConfig.timeout; ignoring',
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(src, 'additionalMounts')) {
    if (Array.isArray(src.additionalMounts)) {
      const mounts = src.additionalMounts
        .filter(
          (
            m,
          ): m is {
            hostPath: string;
            containerPath?: string;
            readonly?: boolean;
          } =>
            !!m &&
            typeof m === 'object' &&
            typeof (m as { hostPath?: unknown }).hostPath === 'string' &&
            ((m as { containerPath?: unknown }).containerPath === undefined ||
              typeof (m as { containerPath?: unknown }).containerPath ===
                'string') &&
            ((m as { readonly?: unknown }).readonly === undefined ||
              typeof (m as { readonly?: unknown }).readonly === 'boolean'),
        )
        .map((m) => ({
          hostPath: m.hostPath,
          ...(m.containerPath !== undefined
            ? { containerPath: m.containerPath }
            : {}),
          ...(m.readonly !== undefined ? { readonly: m.readonly } : {}),
        }));
      if (mounts.length > 0) {
        out.additionalMounts = mounts;
      } else if (src.additionalMounts.length > 0) {
        logger.warn(
          { jid, field },
          'Invalid containerConfig.additionalMounts; ignoring',
        );
      }
    } else {
      logger.warn(
        { jid, field },
        'Invalid containerConfig.additionalMounts; ignoring',
      );
    }
  }
  return out;
}

export function _parseContainerConfigJson(
  containerConfig: string | null,
  jid: string,
): ContainerConfig | undefined {
  if (!containerConfig) return undefined;
  try {
    return _sanitizeContainerConfig(JSON.parse(containerConfig), jid);
  } catch (err) {
    logger.warn(
      { jid, err },
      'Invalid container_config JSON in DB; ignoring this value',
    );
    return undefined;
  }
}

export function _sanitizeThreadDefaults(
  raw: unknown,
  jid: string,
): ThreadDefaults | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn({ jid }, 'Invalid thread_defaults in DB; ignoring');
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const out: ThreadDefaults = {};
  if (Object.prototype.hasOwnProperty.call(src, 'type')) {
    if (src.type === 'chat' || src.type === 'thread') {
      out.type = src.type;
    } else {
      logger.warn(
        { jid, type: src.type },
        'Invalid or privileged thread_defaults.type in DB; ignoring',
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(src, 'requiresTrigger')) {
    if (typeof src.requiresTrigger === 'boolean') {
      out.requiresTrigger = src.requiresTrigger;
    } else {
      logger.warn(
        { jid, requiresTrigger: src.requiresTrigger },
        'Invalid thread_defaults.requiresTrigger in DB; ignoring',
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(src, 'containerConfig')) {
    const cc = _sanitizeContainerConfig(
      src.containerConfig,
      jid,
      'thread_defaults.containerConfig',
    );
    if (cc) out.containerConfig = cc;
  }
  return out;
}

export function _parseThreadDefaultsJson(
  threadDefaults: string | null,
  jid: string,
): ThreadDefaults | undefined {
  if (!threadDefaults) return undefined;
  try {
    return _sanitizeThreadDefaults(JSON.parse(threadDefaults), jid);
  } catch (err) {
    logger.warn(
      { jid, err },
      'Invalid thread_defaults JSON in DB; ignoring this value',
    );
    return undefined;
  }
}

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
      group_jid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS spawned_threads (
      source_message_id TEXT PRIMARY KEY,
      thread_jid        TEXT NOT NULL,
      trigger_kind      TEXT NOT NULL,
      trigger_value     TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spawned_threads_created_at
      ON spawned_threads(created_at);
  `);

  // sessions テーブルのスキーマを group_folder → group_jid に移行。
  // 個人プロジェクトのため後方互換不要。旧テーブルが残っている場合は DROP して再作成。
  try {
    const hasOldColumn = (
      database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
        name: string;
      }>
    ).some((col) => col.name === 'group_folder');
    if (hasOldColumn) {
      database.exec(`DROP TABLE sessions`);
      database.exec(
        `CREATE TABLE IF NOT EXISTS sessions (group_jid TEXT PRIMARY KEY, session_id TEXT NOT NULL)`,
      );
    }
  } catch {
    /* テーブルが存在しないか、すでに移行済み */
  }

  // context_mode カラムが存在しない場合は追加（既存 DB のマイグレーション）
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* カラムはすでに存在します */
  }

  // is_bot_message カラムが存在しない場合は追加（既存 DB のマイグレーション）
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // 過去分への適用: 内容のプレフィックスパターンから既存のボットメッセージをマーク
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* カラムはすでに存在します */
  }

  // is_main カラムが存在しない場合は追加（既存 DB のマイグレーション）
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // 過去分への適用: folder = 'main' の既存行をメイングループとしてマーク
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* カラムはすでに存在します */
  }

  // group_type カラムが存在しない場合は追加（isMain → GroupType マイグレーション）
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN group_type TEXT DEFAULT 'chat'`,
    );
    database.exec(
      `UPDATE registered_groups SET group_type = 'main' WHERE is_main = 1`,
    );
  } catch {
    /* カラムはすでに存在します */
  }

  // thread_defaults カラムが存在しない場合は追加
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN thread_defaults TEXT`,
    );
  } catch {
    /* カラムはすでに存在します */
  }

  // parent_folder カラムが存在しない場合は追加
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN parent_folder TEXT`,
    );
  } catch {
    /* カラムはすでに存在します */
  }

  // channel_mode カラムが存在しない場合は追加
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN channel_mode TEXT`);
  } catch {
    /* カラムはすでに存在します */
  }

  // 旧スキーマ: registered_groups.folder UNIQUE を解除する
  // thread は parent と同じ folder を共有するため、folder の一意制約は不適切。
  try {
    const indexes = database
      .prepare(`PRAGMA index_list('registered_groups')`)
      .all() as Array<{
      name: string;
      unique: number;
    }>;
    const hasUniqueFolderIndex = indexes.some((idx) => {
      if (idx.unique !== 1) return false;
      const safeIndexName = idx.name.replace(/'/g, "''");
      const cols = database
        .prepare(`PRAGMA index_info('${safeIndexName}')`)
        .all() as Array<{ name: string }>;
      return cols.length === 1 && cols[0].name === 'folder';
    });
    if (hasUniqueFolderIndex) {
      const migrate = database.transaction(() => {
        database.exec(`
          ALTER TABLE registered_groups RENAME TO registered_groups_old;
          CREATE TABLE registered_groups (
            jid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            folder TEXT NOT NULL,
            trigger_pattern TEXT NOT NULL,
            added_at TEXT NOT NULL,
            container_config TEXT,
            requires_trigger INTEGER DEFAULT 1,
            is_main INTEGER DEFAULT 0,
            group_type TEXT DEFAULT 'chat',
            thread_defaults TEXT,
            parent_folder TEXT,
            channel_mode TEXT
          );
          INSERT INTO registered_groups (
            jid, name, folder, trigger_pattern, added_at, container_config,
            requires_trigger, is_main, group_type, thread_defaults,
            parent_folder, channel_mode
          )
          SELECT
            jid, name, folder, trigger_pattern, added_at, container_config,
            requires_trigger, is_main, group_type, thread_defaults,
            parent_folder, channel_mode
          FROM registered_groups_old;
          DROP TABLE registered_groups_old;
        `);
      });
      migrate();
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to migrate registered_groups folder uniqueness',
    );
  }

  // channel および is_group カラムが存在しない場合は追加（既存 DB のマイグレーション）
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // JID パターンから過去分への適用
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
    /* カラムはすでに存在します */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // JSON ファイルが存在する場合はマイグレーションを実行
  migrateJsonState();
  cleanupSpawnedThreads();
}

/** @internal - テスト用のみ。新規のインメモリデータベースを作成します。 */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * チャットのメタデータのみを保存します（メッセージ内容は含みません）。
 * 機密性の高い内容を保存せずにグループ検出を可能にするため、すべてのチャットで使用されます。
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
    // 名前で更新。既存のタイムスタンプの方が新しい場合はそれを保持。
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
    // タイムスタンプのみ更新。既存の名前があれば保持。
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
 * 既存チャットのタイムスタンプを変更せずにチャット名を更新します。
 * 新規チャットの初期タイムスタンプには現在時刻が設定されます。
 * グループメタデータの同期中に使用されます。
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
 * すべての既知のチャットを、直近のアクティビティ順に取得します。
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
 * 最後のグループメタデータ同期のタイムスタンプを取得します。
 */
export function getLastGroupSync(): string | null {
  // 同期時刻は特別なチャットエントリに保存されます
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * グループメタデータが同期されたことを記録します。
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * メッセージの内容を含めて保存します。
 * メッセージ履歴が必要な、登録済みグループに対してのみ呼び出してください。
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
 * メッセージを直接保存します。
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
  // ボットのメッセージを除外するために is_bot_message フラグと内容のプレフィックスの両方を使用します。
  // 内容のプレフィックスはマイグレーション実行前のメッセージに対するバックストップです。
  // サブクエリで最新の N 件を取得し、外側のクエリで時系列順に並べ替えます。
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
  // ボットのメッセージを除外するために is_bot_message フラグと内容のプレフィックスの両方を使用します。
  // 内容のプレフィックスはマイグレーション実行前のメッセージに対するバックストップです。
  // サブクエリで最新の N 件を取得し、外側のクエリで時系列順に並べ替えます。
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
  // 外部キー制約のため、まず子レコードを削除します
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

// --- ルーターステート・アクセッサー ---

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

// --- セッション・アクセッサー ---
// sessions テーブルのキーは group_jid（例: dc:123456789）。
// Phase 3 でセッション分離を group 単位に変更した。

export function getSession(groupJid: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_jid = ?')
    .get(groupJid) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupJid: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_jid, session_id) VALUES (?, ?)',
  ).run(groupJid, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_jid, session_id FROM sessions')
    .all() as Array<{ group_jid: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_jid] = row.session_id;
  }
  return result;
}

// --- 登録済みグループ・アクセッサー ---

/** DB から取得した parent_folder を検証してサニタイズする */
function sanitizeParentFolder(
  parentFolder: string | null,
  jid: string,
): string | undefined {
  if (!parentFolder) return undefined;
  if (!isValidGroupFolder(parentFolder)) {
    logger.warn({ jid, parentFolder }, 'Invalid parent_folder in DB; ignoring');
    return undefined;
  }
  return parentFolder;
}

/** channel_mode を DB 値から検証する */
function parseChannelMode(raw: string | null): RegisteredGroup['channel_mode'] {
  if (raw === 'chat' || raw === 'url_watch' || raw === 'admin_control') {
    return raw;
  }
  return undefined;
}

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
        group_type: string | null;
        thread_defaults: string | null;
        parent_folder: string | null;
        channel_mode: string | null;
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
  const groupType = parseGroupType(row.group_type, row.is_main, row.jid);
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    parent_folder: sanitizeParentFolder(row.parent_folder, row.jid),
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: _parseContainerConfigJson(row.container_config, row.jid),
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    type: groupType,
    thread_defaults: _parseThreadDefaultsJson(row.thread_defaults, row.jid),
    channel_mode: parseChannelMode(row.channel_mode),
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  const rawType = group.type ?? 'chat';
  // JSON 移行や外部入力経由で不正値が混入する可能性があるため、書き込み前に検証する
  if (!VALID_GROUP_TYPES.has(rawType)) {
    logger.warn(
      { jid, rawType },
      'Invalid group.type; falling back to "chat".',
    );
  }
  const groupType = VALID_GROUP_TYPES.has(rawType) ? rawType : 'chat';
  // parent_folder の検証: null か有効なフォルダ名のみ許可
  const parentFolder =
    group.parent_folder && isValidGroupFolder(group.parent_folder)
      ? group.parent_folder
      : null;
  const channelMode = parseChannelMode(group.channel_mode ?? null);
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, group_type, thread_defaults, parent_folder, channel_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       folder = excluded.folder,
       trigger_pattern = excluded.trigger_pattern,
       added_at = excluded.added_at,
       container_config = excluded.container_config,
       requires_trigger = excluded.requires_trigger,
       is_main = excluded.is_main,
       group_type = excluded.group_type,
       thread_defaults = excluded.thread_defaults,
       parent_folder = excluded.parent_folder,
       channel_mode = excluded.channel_mode`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    groupType === 'main' || groupType === 'override' ? 1 : 0,
    groupType,
    group.thread_defaults ? JSON.stringify(group.thread_defaults) : null,
    parentFolder,
    channelMode ?? null,
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
    group_type: string | null;
    thread_defaults: string | null;
    parent_folder: string | null;
    channel_mode: string | null;
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
    const groupType = parseGroupType(row.group_type, row.is_main, row.jid);
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      parent_folder: sanitizeParentFolder(row.parent_folder, row.jid),
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: _parseContainerConfigJson(row.container_config, row.jid),
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      type: groupType,
      thread_defaults: _parseThreadDefaultsJson(row.thread_defaults, row.jid),
      channel_mode: parseChannelMode(row.channel_mode),
    };
  }
  return result;
}

// --- スポーン済みスレッド・アクセッサー ---

/**
 * 指定されたソースメッセージ ID からスレッドがスポーン済みかどうかを返す。
 * 重複スポーン防止に使用する。
 */
export function hasSpawnedThread(sourceMessageId: string): boolean {
  const row = db
    .prepare(
      'SELECT source_message_id FROM spawned_threads WHERE source_message_id = ?',
    )
    .get(sourceMessageId);
  return row !== undefined;
}

/**
 * source_message_id に対するスポーン処理を予約する。
 * true: この呼び出しが予約を獲得した（作成処理を続行してよい）
 * false: 既に他の処理が予約済み/作成済み
 */
export function reserveSpawnedThread(
  sourceMessageId: string,
  triggerKind: string,
  triggerValue: string,
): boolean {
  return recordSpawnedThread(
    sourceMessageId,
    PENDING_SPAWN_THREAD_JID,
    triggerKind,
    triggerValue,
  );
}

/**
 * 予約済みスポーンレコードを確定し、実際の thread JID を保存する。
 */
export function finalizeSpawnedThread(
  sourceMessageId: string,
  threadJid: string,
): void {
  db.prepare(
    `UPDATE spawned_threads
     SET thread_jid = ?
     WHERE source_message_id = ?`,
  ).run(threadJid, sourceMessageId);
}

/**
 * 失敗したスポーン予約を解放する。
 */
export function releaseSpawnedThreadReservation(sourceMessageId: string): void {
  db.prepare(
    `DELETE FROM spawned_threads
     WHERE source_message_id = ? AND thread_jid = ?`,
  ).run(sourceMessageId, PENDING_SPAWN_THREAD_JID);
}

/**
 * スポーン済みスレッドを記録する。
 */
export function recordSpawnedThread(
  sourceMessageId: string,
  threadJid: string,
  triggerKind: string,
  triggerValue: string,
  createdAt: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO spawned_threads (source_message_id, thread_jid, trigger_kind, trigger_value, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sourceMessageId, threadJid, triggerKind, triggerValue, createdAt);
  return result.changes === 1;
}

/**
 * 古い spawned_threads レコードを GC する。
 */
export function cleanupSpawnedThreads(
  now: Date = new Date(),
  retentionDays: number = SPAWNED_THREAD_RETENTION_DAYS,
): number {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = db
    .prepare(`DELETE FROM spawned_threads WHERE created_at < ?`)
    .run(cutoff.toISOString());
  if (result.changes > 0) {
    logger.info(
      { deletedRows: result.changes, retentionDays },
      'Cleaned up stale spawned_threads rows',
    );
  }
  return result.changes;
}

// --- JSON マイグレーション ---

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

  // router_state.json のマイグレーション
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

  // sessions.json のマイグレーション
  // sessions テーブルのキーは group_jid（例: dc:123、tg:456、xxx@g.us）。
  // 旧形式の folder キーは移行対象から除外する。
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [key, sessionId] of Object.entries(sessions)) {
      if (_shouldMigrateSessionKey(key)) {
        setSession(key, sessionId);
      }
    }
  }

  // registered_groups.json のマイグレーション
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
