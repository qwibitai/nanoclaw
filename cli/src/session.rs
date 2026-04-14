use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// An assistant message extracted from a session JSONL file.
#[derive(Debug, Clone)]
pub struct SessionAssistantMessage {
    pub content: String,
    pub timestamp: String,
}

/// Find the session JSONL file for a given session ID.
/// Searches: data/sessions/{group_folder}/.claude/projects/*/{session_id}.jsonl
pub fn find_session_file(
    project_root: &Path,
    group_folder: &str,
    session_id: &str,
) -> Option<PathBuf> {
    let projects_dir = project_root
        .join("data")
        .join("sessions")
        .join(group_folder)
        .join(".claude")
        .join("projects");

    let filename = format!("{session_id}.jsonl");

    // Search all project subdirectories
    let entries = fs::read_dir(&projects_dir).ok()?;
    for entry in entries.flatten() {
        if entry.file_type().ok()?.is_dir() {
            let candidate = entry.path().join(&filename);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Read assistant text messages from a session JSONL file.
/// Returns the last `limit` messages in chronological order.
pub fn read_assistant_messages(
    path: &Path,
    limit: usize,
) -> Vec<SessionAssistantMessage> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let reader = std::io::BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        // Quick filter before full JSON parse
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }

        let obj: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if obj.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }

        let timestamp = obj
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // Extract text content from the message
        let content = obj.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(blocks)) => {
                // Find the last text block (final response text)
                let mut last_text = String::new();
                for block in blocks {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            last_text = t.to_string();
                        }
                    }
                }
                last_text
            }
            _ => continue,
        };

        if text.is_empty() {
            continue;
        }

        messages.push(SessionAssistantMessage {
            content: text,
            timestamp,
        });
    }

    // Return last `limit` messages
    if messages.len() > limit {
        messages.split_off(messages.len() - limit)
    } else {
        messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_find_session_file() {
        let dir = TempDir::new().unwrap();
        let projects_dir = dir
            .path()
            .join("data/sessions/tg_main/.claude/projects/some-project");
        fs::create_dir_all(&projects_dir).unwrap();
        let session_file = projects_dir.join("sess-abc.jsonl");
        fs::write(&session_file, "").unwrap();

        let result = find_session_file(dir.path(), "tg_main", "sess-abc");
        assert_eq!(result, Some(session_file));
    }

    #[test]
    fn test_find_session_file_not_found() {
        let dir = TempDir::new().unwrap();
        let projects_dir = dir
            .path()
            .join("data/sessions/tg_main/.claude/projects/some-project");
        fs::create_dir_all(&projects_dir).unwrap();

        let result = find_session_file(dir.path(), "tg_main", "nonexistent");
        assert!(result.is_none());
    }

    #[test]
    fn test_read_assistant_messages() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");
        let mut f = fs::File::create(&path).unwrap();

        // User message (should be skipped)
        writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"hello"}},"timestamp":"2026-01-01T10:00:00Z"}}"#).unwrap();
        // Assistant with text content
        writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"thinking","thinking":"..."}},{{"type":"text","text":"Hi there!"}}]}},"timestamp":"2026-01-01T10:00:05Z"}}"#).unwrap();
        // Assistant with string content
        writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":"Simple reply"}},"timestamp":"2026-01-01T10:01:00Z"}}"#).unwrap();
        // Assistant with only thinking (no text — should be skipped)
        writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"thinking","thinking":"..."}}]}},"timestamp":"2026-01-01T10:01:30Z"}}"#).unwrap();

        let msgs = read_assistant_messages(&path, 10);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "Hi there!");
        assert_eq!(msgs[0].timestamp, "2026-01-01T10:00:05Z");
        assert_eq!(msgs[1].content, "Simple reply");
    }

    #[test]
    fn test_read_assistant_messages_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");
        let mut f = fs::File::create(&path).unwrap();

        for i in 0..10 {
            writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":"msg {i}"}},"timestamp":"2026-01-01T10:{i:02}:00Z"}}"#).unwrap();
        }

        let msgs = read_assistant_messages(&path, 3);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].content, "msg 7");
        assert_eq!(msgs[2].content, "msg 9");
    }

    #[test]
    fn test_read_assistant_messages_nonexistent() {
        let msgs = read_assistant_messages(Path::new("/nonexistent"), 10);
        assert!(msgs.is_empty());
    }
}
