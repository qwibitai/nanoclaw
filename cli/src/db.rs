use std::path::Path;

use chrono::{DateTime, Local, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags};

/// A row from the registered_groups table.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct GroupRow {
    pub jid: String,
    pub name: String,
    pub folder: String,
    pub trigger_pattern: String,
    pub is_main: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// A row from the messages table.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MessageRow {
    pub id: String,
    pub sender_name: String,
    pub content: String,
    pub timestamp: String,
    pub is_from_me: bool,
    pub is_bot_message: bool,
}

/// A row from the scheduled_tasks table.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TaskRow {
    pub id: String,
    pub group_folder: String,
    pub prompt: String,
    pub schedule_type: String,
    pub schedule_value: String,
    pub status: String,
    pub model: Option<String>,
    pub next_run: Option<String>,
    pub last_run: Option<String>,
}

/// Open the database in read-only mode.
pub fn open_readonly(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open database: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")
        .map_err(|e| format!("Failed to set busy timeout: {e}"))?;
    Ok(conn)
}

/// Open the database for writing (session updates, model changes).
fn open_readwrite(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .map_err(|e| format!("Failed to open database for writing: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")
        .map_err(|e| format!("Failed to set busy timeout: {e}"))?;
    Ok(conn)
}

/// Get the main group (is_main = 1).
pub fn get_main_group(conn: &Connection) -> Result<GroupRow, String> {
    conn.query_row(
        "SELECT jid, name, folder, trigger_pattern, is_main, model, effort
         FROM registered_groups WHERE is_main = 1 LIMIT 1",
        [],
        |row| {
            Ok(GroupRow {
                jid: row.get(0)?,
                name: row.get(1)?,
                folder: row.get(2)?,
                trigger_pattern: row.get(3)?,
                is_main: row.get::<_, i32>(4)? != 0,
                model: row.get(5)?,
                effort: row.get(6)?,
            })
        },
    )
    .map_err(|_| "No main group registered. Use -g to specify a group.".to_string())
}

/// Find a group by name or folder (case-insensitive fuzzy match).
pub fn find_group(conn: &Connection, query: &str) -> Result<GroupRow, String> {
    let q = query.to_lowercase();

    let mut stmt = conn
        .prepare(
            "SELECT jid, name, folder, trigger_pattern, is_main, model, effort
             FROM registered_groups ORDER BY name",
        )
        .map_err(|e| format!("Query error: {e}"))?;

    let groups: Vec<GroupRow> = stmt
        .query_map([], |row| {
            Ok(GroupRow {
                jid: row.get(0)?,
                name: row.get(1)?,
                folder: row.get(2)?,
                trigger_pattern: row.get(3)?,
                is_main: row.get::<_, i32>(4)? != 0,
                model: row.get(5)?,
                effort: row.get(6)?,
            })
        })
        .map_err(|e| format!("Query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Exact match first
    for g in &groups {
        if g.name.to_lowercase() == q || g.folder.to_lowercase() == q {
            return Ok(g.clone());
        }
    }

    // Partial match
    let matches: Vec<&GroupRow> = groups
        .iter()
        .filter(|g| {
            g.name.to_lowercase().contains(&q) || g.folder.to_lowercase().contains(&q)
        })
        .collect();

    match matches.len() {
        0 => Err(format!("Group '{query}' not found. Check registered groups.")),
        1 => Ok(matches[0].clone()),
        _ => {
            let names: Vec<&str> = matches.iter().map(|g| g.name.as_str()).collect();
            Err(format!(
                "Ambiguous group '{query}'. Matches: {}",
                names.join(", ")
            ))
        }
    }
}

/// Get the session ID for a group folder.
pub fn get_session(conn: &Connection, group_folder: &str) -> Option<String> {
    conn.query_row(
        "SELECT session_id FROM sessions WHERE group_folder = ?1",
        [group_folder],
        |row| row.get(0),
    )
    .ok()
}

/// Save the session ID for a group folder.
pub fn set_session(db_path: &Path, group_folder: &str, session_id: &str) -> Result<(), String> {
    let conn = open_readwrite(db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?1, ?2)",
        [group_folder, session_id],
    )
    .map_err(|e| format!("Failed to save session: {e}"))?;
    Ok(())
}

/// Delete the session for a group folder.
pub fn delete_session(db_path: &Path, group_folder: &str) -> Result<(), String> {
    let conn = open_readwrite(db_path)?;
    conn.execute(
        "DELETE FROM sessions WHERE group_folder = ?1",
        [group_folder],
    )
    .map_err(|e| format!("Failed to delete session: {e}"))?;
    Ok(())
}

/// Get scheduled tasks for a group folder.
pub fn get_tasks(conn: &Connection, group_folder: &str) -> Vec<TaskRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, group_folder, prompt, schedule_type, schedule_value,
                status, model, next_run, last_run
         FROM scheduled_tasks WHERE group_folder = ?1 ORDER BY created_at",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    stmt.query_map([group_folder], |row| {
        Ok(TaskRow {
            id: row.get(0)?,
            group_folder: row.get(1)?,
            prompt: row.get(2)?,
            schedule_type: row.get(3)?,
            schedule_value: row.get(4)?,
            status: row.get(5)?,
            model: row.get(6)?,
            next_run: row.get(7)?,
            last_run: row.get(8)?,
        })
    })
    .ok()
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

/// Get recent messages from the database for history display.
pub fn get_messages(conn: &Connection, chat_jid: &str, limit: usize) -> Vec<MessageRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ?1
         ORDER BY timestamp DESC LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut rows: Vec<MessageRow> = stmt
        .query_map(rusqlite::params![chat_jid, limit as i64], |row| {
            Ok(MessageRow {
                id: row.get(0)?,
                sender_name: row.get(1)?,
                content: row.get(2)?,
                timestamp: row.get(3)?,
                is_from_me: row.get::<_, i32>(4)? != 0,
                is_bot_message: row.get::<_, i32>(5)? != 0,
            })
        })
        .ok()
        .map(|r| r.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    // Reverse to chronological order
    rows.reverse();
    rows
}

/// Set the model override for a group.
pub fn set_group_model(db_path: &Path, jid: &str, model: Option<&str>) -> Result<(), String> {
    let conn = open_readwrite(db_path)?;
    conn.execute(
        "UPDATE registered_groups SET model = ?1 WHERE jid = ?2",
        rusqlite::params![model, jid],
    )
    .map_err(|e| format!("Failed to update model: {e}"))?;
    Ok(())
}

/// Convert an ISO 8601 timestamp string to local HH:MM format.
pub fn format_local_time(iso_ts: &str) -> String {
    // Try as naive datetime (no timezone info), assume stored as UTC
    if let Ok(naive) = NaiveDateTime::parse_from_str(iso_ts, "%Y-%m-%dT%H:%M:%S") {
        let utc = DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc);
        return utc.with_timezone(&Local).format("%H:%M").to_string();
    }
    // Try as RFC 3339 (includes timezone)
    if let Ok(dt) = DateTime::parse_from_rfc3339(iso_ts) {
        return dt.with_timezone(&Local).format("%H:%M").to_string();
    }
    // Fallback: extract HH:MM from string
    let time = iso_ts.split('T').nth(1).unwrap_or(iso_ts);
    if time.len() >= 5 {
        time[..5].to_string()
    } else {
        time.to_string()
    }
}

/// Get messages newer than the given timestamp (for DB polling).
pub fn get_messages_since(conn: &Connection, chat_jid: &str, since_ts: &str) -> Vec<MessageRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ?1 AND timestamp > ?2
         ORDER BY timestamp ASC LIMIT 100",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    stmt.query_map(rusqlite::params![chat_jid, since_ts], |row| {
        Ok(MessageRow {
            id: row.get(0)?,
            sender_name: row.get(1)?,
            content: row.get(2)?,
            timestamp: row.get(3)?,
            is_from_me: row.get::<_, i32>(4)? != 0,
            is_bot_message: row.get::<_, i32>(5)? != 0,
        })
    })
    .ok()
    .map(|r| r.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

/// Set the effort override for a group.
pub fn set_group_effort(db_path: &Path, jid: &str, effort: Option<&str>) -> Result<(), String> {
    let conn = open_readwrite(db_path)?;
    conn.execute(
        "UPDATE registered_groups SET effort = ?1 WHERE jid = ?2",
        rusqlite::params![effort, jid],
    )
    .map_err(|e| format!("Failed to update effort: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_db() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("messages.db");
        let conn = Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "
            CREATE TABLE registered_groups (
                jid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder TEXT NOT NULL UNIQUE,
                trigger_pattern TEXT NOT NULL,
                added_at TEXT NOT NULL,
                container_config TEXT,
                requires_trigger INTEGER DEFAULT 1,
                is_main INTEGER DEFAULT 0,
                model TEXT,
                effort TEXT
            );
            CREATE TABLE sessions (
                group_folder TEXT PRIMARY KEY,
                session_id TEXT NOT NULL
            );
            CREATE TABLE scheduled_tasks (
                id TEXT PRIMARY KEY,
                group_folder TEXT NOT NULL,
                chat_jid TEXT NOT NULL,
                prompt TEXT NOT NULL,
                script TEXT,
                schedule_type TEXT NOT NULL,
                schedule_value TEXT NOT NULL,
                context_mode TEXT DEFAULT 'isolated',
                silent INTEGER DEFAULT 0,
                model TEXT,
                effort TEXT,
                next_run TEXT,
                last_run TEXT,
                last_result TEXT,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE TABLE messages (
                id TEXT,
                chat_jid TEXT,
                sender TEXT,
                sender_name TEXT,
                content TEXT,
                timestamp TEXT,
                is_from_me INTEGER,
                is_bot_message INTEGER DEFAULT 0,
                reply_to_message_id TEXT,
                reply_to_message_content TEXT,
                reply_to_sender_name TEXT,
                PRIMARY KEY (id, chat_jid)
            );

            INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
            VALUES ('tg:123', 'Main Group', 'telegram_main', '@Andy', '2025-01-01', 1);
            INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
            VALUES ('tg:456', 'Dev Group', 'dev_group', '@Andy', '2025-01-01', 0);
            INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, model)
            VALUES ('tg:789', 'Test Group', 'test_group', '@Andy', '2025-01-01', 0, 'claude-opus-4-20250514');
            ",
        )
        .unwrap();

        (dir, db_path)
    }

    #[test]
    fn test_get_main_group() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = get_main_group(&conn).unwrap();
        assert_eq!(group.jid, "tg:123");
        assert_eq!(group.folder, "telegram_main");
        assert!(group.is_main);
    }

    #[test]
    fn test_find_group_exact_name() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = find_group(&conn, "Dev Group").unwrap();
        assert_eq!(group.folder, "dev_group");
    }

    #[test]
    fn test_find_group_exact_folder() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = find_group(&conn, "telegram_main").unwrap();
        assert_eq!(group.jid, "tg:123");
    }

    #[test]
    fn test_find_group_partial() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = find_group(&conn, "dev").unwrap();
        assert_eq!(group.folder, "dev_group");
    }

    #[test]
    fn test_find_group_case_insensitive() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = find_group(&conn, "TELEGRAM_MAIN").unwrap();
        assert_eq!(group.folder, "telegram_main");
    }

    #[test]
    fn test_find_group_not_found() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let result = find_group(&conn, "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_find_group_ambiguous() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        // "group" matches both "Dev Group" and "Test Group"
        let result = find_group(&conn, "group");
        // Should match multiple - either ambiguous or pick the first
        // Both "Dev Group" and "Test Group" contain "group"
        assert!(result.is_err());
    }

    #[test]
    fn test_session_crud() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();

        // No session initially
        assert!(get_session(&conn, "telegram_main").is_none());

        // Set session
        set_session(&db_path, "telegram_main", "session-abc-123").unwrap();

        // Read it back
        let conn = open_readonly(&db_path).unwrap();
        assert_eq!(
            get_session(&conn, "telegram_main").unwrap(),
            "session-abc-123"
        );

        // Update session
        set_session(&db_path, "telegram_main", "session-xyz-456").unwrap();
        let conn = open_readonly(&db_path).unwrap();
        assert_eq!(
            get_session(&conn, "telegram_main").unwrap(),
            "session-xyz-456"
        );

        // Delete session
        delete_session(&db_path, "telegram_main").unwrap();
        let conn = open_readonly(&db_path).unwrap();
        assert!(get_session(&conn, "telegram_main").is_none());
    }

    #[test]
    fn test_get_tasks_empty() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let tasks = get_tasks(&conn, "telegram_main");
        assert!(tasks.is_empty());
    }

    #[test]
    fn test_get_tasks_with_data() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
                 VALUES ('task-1', 'telegram_main', 'tg:123', 'Check logs', 'cron', '0 9 * * *', 'active', '2025-01-01')",
                [],
            ).unwrap();
        }

        let conn = open_readonly(&db_path).unwrap();
        let tasks = get_tasks(&conn, "telegram_main");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-1");
        assert_eq!(tasks[0].prompt, "Check logs");
    }

    #[test]
    fn test_get_messages() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                 VALUES ('m1', 'tg:123', 'u1', 'Alice', 'Hello', '2025-01-01T10:00:00', 0, 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                 VALUES ('m2', 'tg:123', 'bot', 'Andy', 'Hi there', '2025-01-01T10:01:00', 1, 1)",
                [],
            ).unwrap();
        }

        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages(&conn, "tg:123", 10);
        assert_eq!(msgs.len(), 2);
        // Should be in chronological order
        assert_eq!(msgs[0].sender_name, "Alice");
        assert_eq!(msgs[1].sender_name, "Andy");
    }

    #[test]
    fn test_set_group_model() {
        let (_dir, db_path) = create_test_db();
        set_group_model(&db_path, "tg:123", Some("claude-opus-4-20250514")).unwrap();

        let conn = open_readonly(&db_path).unwrap();
        let group = get_main_group(&conn).unwrap();
        assert_eq!(group.model.unwrap(), "claude-opus-4-20250514");

        // Reset
        set_group_model(&db_path, "tg:123", None).unwrap();
        let conn = open_readonly(&db_path).unwrap();
        let group = get_main_group(&conn).unwrap();
        assert!(group.model.is_none());
    }

    #[test]
    fn test_get_messages_with_limit() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            for i in 0..10 {
                conn.execute(
                    "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                     VALUES (?1, 'tg:123', 'u1', 'Alice', ?2, ?3, 0, 0)",
                    rusqlite::params![
                        format!("m{i}"),
                        format!("Message {i}"),
                        format!("2025-01-01T10:{:02}:00", i)
                    ],
                ).unwrap();
            }
        }

        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages(&conn, "tg:123", 3);
        assert_eq!(msgs.len(), 3);
        // Should be the last 3 messages in chronological order
        assert_eq!(msgs[0].content, "Message 7");
        assert_eq!(msgs[2].content, "Message 9");
    }

    #[test]
    fn test_get_messages_empty() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages(&conn, "tg:nonexistent", 10);
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_find_group_with_model() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let group = find_group(&conn, "test_group").unwrap();
        assert_eq!(group.model.as_deref(), Some("claude-opus-4-20250514"));
    }

    #[test]
    fn test_get_tasks_wrong_folder() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
                 VALUES ('task-1', 'other_group', 'tg:999', 'Task', 'cron', '0 9 * * *', 'active', '2025-01-01')",
                [],
            ).unwrap();
        }
        let conn = open_readonly(&db_path).unwrap();
        let tasks = get_tasks(&conn, "telegram_main");
        assert!(tasks.is_empty());
    }

    #[test]
    fn test_delete_session_nonexistent() {
        let (_dir, db_path) = create_test_db();
        // Deleting a nonexistent session should not error
        let result = delete_session(&db_path, "nonexistent_folder");
        assert!(result.is_ok());
    }

    #[test]
    fn test_set_group_effort() {
        let (_dir, db_path) = create_test_db();
        set_group_effort(&db_path, "tg:123", Some("high")).unwrap();

        let conn = open_readonly(&db_path).unwrap();
        let group = get_main_group(&conn).unwrap();
        assert_eq!(group.effort.unwrap(), "high");
    }

    #[test]
    fn test_format_local_time_naive() {
        // Should parse and return a HH:MM string (exact value depends on local TZ)
        let result = format_local_time("2025-01-01T10:30:00");
        assert_eq!(result.len(), 5);
        assert!(result.contains(':'));
    }

    #[test]
    fn test_format_local_time_rfc3339() {
        let result = format_local_time("2025-01-01T10:30:00+00:00");
        assert_eq!(result.len(), 5);
        assert!(result.contains(':'));
    }

    #[test]
    fn test_format_local_time_fallback() {
        // Non-parseable input falls back to string extraction (first 5 chars)
        let result = format_local_time("not-a-timestamp");
        assert_eq!(result, "not-a");
    }

    #[test]
    fn test_format_local_time_fallback_with_t() {
        let result = format_local_time("badTHH:MM:SS");
        assert_eq!(result, "HH:MM");
    }

    #[test]
    fn test_get_messages_since() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                 VALUES ('m1', 'tg:123', 'u1', 'Alice', 'Old msg', '2025-01-01T10:00:00', 0, 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                 VALUES ('m2', 'tg:123', 'bot', 'Andy', 'New msg', '2025-01-01T10:05:00', 1, 1)",
                [],
            ).unwrap();
        }
        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages_since(&conn, "tg:123", "2025-01-01T10:00:00");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "New msg");
        assert!(msgs[0].is_bot_message);
    }

    #[test]
    fn test_get_messages_since_empty() {
        let (_dir, db_path) = create_test_db();
        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages_since(&conn, "tg:123", "2025-01-01T10:00:00");
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_get_messages_since_all_older() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
                 VALUES ('m1', 'tg:123', 'u1', 'Alice', 'Old msg', '2025-01-01T10:00:00', 0, 0)",
                [],
            ).unwrap();
        }
        let conn = open_readonly(&db_path).unwrap();
        let msgs = get_messages_since(&conn, "tg:123", "2025-01-01T10:00:00");
        assert!(msgs.is_empty()); // strict > means equal timestamp is excluded
    }
}
