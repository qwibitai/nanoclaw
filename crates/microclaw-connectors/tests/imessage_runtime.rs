use microclaw_connectors::{CommandExecutor, CommandResult, IMessageConnector, IMessageMessage};
use rusqlite::Connection;

struct StubExecutor {
    called: std::sync::Mutex<Vec<String>>,
}

impl StubExecutor {
    fn new() -> Self {
        Self {
            called: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl CommandExecutor for StubExecutor {
    fn run(&self, args: &[String]) -> Result<CommandResult, String> {
        self.called.lock().unwrap().extend_from_slice(args);
        Ok(CommandResult {
            status: 0,
            stdout: String::new(),
            stderr: String::new(),
        })
    }
}

#[test]
fn send_uses_osascript() {
    let executor = StubExecutor::new();
    IMessageConnector::send_with_executor(&executor, "+15551212", "hello").unwrap();
    let args = executor.called.lock().unwrap();
    assert_eq!(args[0], "osascript");
    assert_eq!(args[1], "-e");
}

#[test]
fn fetch_since_reads_new_messages() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let conn = Connection::open(tmp.path()).unwrap();
    conn.execute_batch(
        "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
         CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date TEXT, handle_id INTEGER);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO handle (id) VALUES (?)",
        ["sender@example.com"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message (text, date, handle_id) VALUES (?, ?, ?)",
        ("hi", "2026-02-12T00:00:00Z", 1),
    )
    .unwrap();

    let messages = IMessageConnector::fetch_since(tmp.path(), 0).unwrap();
    assert_eq!(
        messages,
        vec![IMessageMessage {
            rowid: 1,
            text: "hi".to_string(),
            sender: "sender@example.com".to_string(),
        }]
    );

    let none = IMessageConnector::fetch_since(tmp.path(), 1).unwrap();
    assert!(none.is_empty());
}
