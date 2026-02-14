use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;

pub struct Store {
    conn: Connection,
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER
);

CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
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
  created_at TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated'
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
"#;

fn create_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)",
        [],
    )?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))?;
    if count == 0 {
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
    }
    Ok(())
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path.as_ref())?;
        create_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = rusqlite::Connection::open_in_memory()?;
        create_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &rusqlite::Connection {
        &self.conn
    }

    pub fn schema_version(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get(0)
            })
    }

    pub fn upsert_registered_group(&self, group: &RegisteredGroup) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(jid) DO UPDATE SET
               name = excluded.name,
               folder = excluded.folder,
               trigger_pattern = excluded.trigger_pattern,
               added_at = excluded.added_at,
               container_config = excluded.container_config,
               requires_trigger = excluded.requires_trigger",
            params![
                group.jid,
                group.name,
                group.folder,
                group.trigger_pattern,
                group.added_at,
                group.container_config,
                if group.requires_trigger { 1 } else { 0 }
            ],
        )?;
        Ok(())
    }

    pub fn load_registered_groups(&self) -> SqlResult<Vec<RegisteredGroup>> {
        let mut stmt = self.conn.prepare(
            "SELECT jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger
             FROM registered_groups
             ORDER BY added_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RegisteredGroup {
                jid: row.get(0)?,
                name: row.get(1)?,
                folder: row.get(2)?,
                trigger_pattern: row.get(3)?,
                added_at: row.get(4)?,
                container_config: row.get(5)?,
                requires_trigger: row.get::<_, i64>(6)? != 0,
            })
        })?;
        let mut groups = Vec::new();
        for row in rows {
            groups.push(row?);
        }
        Ok(groups)
    }

    pub fn store_message(&self, msg: &StoredMessage) -> SqlResult<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)",
            params![msg.chat_jid, msg.chat_jid, msg.timestamp],
        )?;
        self.conn.execute(
            "INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                msg.id,
                msg.chat_jid,
                msg.sender,
                msg.sender_name,
                msg.content,
                msg.timestamp,
                if msg.is_from_me { 1 } else { 0 }
            ],
        )?;
        Ok(())
    }

    pub fn load_new_messages(
        &self,
        jids: &[String],
        last_timestamp: &str,
        bot_prefix: &str,
    ) -> SqlResult<Vec<StoredMessage>> {
        if jids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = std::iter::repeat("?")
            .take(jids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
             FROM messages
             WHERE timestamp > ? AND chat_jid IN ({}) AND content NOT LIKE ?
             ORDER BY timestamp",
            placeholders
        );
        let mut params_vec: Vec<String> = Vec::with_capacity(jids.len() + 2);
        params_vec.push(last_timestamp.to_string());
        params_vec.extend(jids.iter().cloned());
        params_vec.push(format!("{}:%", bot_prefix));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                chat_jid: row.get(1)?,
                sender: row.get(2)?,
                sender_name: row.get(3)?,
                content: row.get(4)?,
                timestamp: row.get(5)?,
                is_from_me: row.get::<_, i64>(6)? != 0,
            })
        })?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }
        Ok(messages)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredGroup {
    pub jid: String,
    pub name: String,
    pub folder: String,
    pub trigger_pattern: String,
    pub added_at: String,
    pub container_config: Option<String>,
    pub requires_trigger: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub id: String,
    pub chat_jid: String,
    pub sender: String,
    pub sender_name: String,
    pub content: String,
    pub timestamp: String,
    pub is_from_me: bool,
}
