use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::config::NanoClawConfig;
use crate::event::AppEvent;

const OUTPUT_START_MARKER: &str = "---NANOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER: &str = "---NANOCLAW_OUTPUT_END---";

/// Input payload sent to agent-runner via stdin.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInput {
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub group_folder: String,
    pub chat_jid: String,
    pub is_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// Output parsed from agent-runner stdout.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOutput {
    pub status: String,
    pub result: Option<String>,
    pub new_session_id: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub partial: Option<bool>,
    pub usage: Option<Usage>,
    pub context_window: Option<u64>,
    pub compacted: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub num_turns: u64,
}

/// Manages the agent-runner child process.
pub struct AgentHandle {
    pub child: Option<Child>,
}

impl AgentHandle {
    /// Spawn the agent-runner process and start parsing its stdout.
    pub async fn spawn(
        config: &NanoClawConfig,
        input: ContainerInput,
        event_tx: mpsc::UnboundedSender<AppEvent>,
    ) -> Result<Self, String> {
        // Check agent-runner exists
        if !config.agent_runner_entry.exists() {
            return Err(format!(
                "agent-runner not found at {}. Run `npm run build` in the NanoClaw directory.",
                config.agent_runner_entry.display()
            ));
        }

        // Ensure required directories exist
        ensure_dirs(config)?;

        // Build environment
        let env = build_env(config);

        // Spawn node process
        let mut child = Command::new("node")
            .arg(&config.agent_runner_entry)
            .current_dir(&config.group_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .envs(&env)
            .spawn()
            .map_err(|e| format!("Failed to spawn agent-runner: {e}"))?;

        // Write ContainerInput to stdin and close it
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let json = serde_json::to_string(&input)
            .map_err(|e| format!("Failed to serialize input: {e}"))?;

        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stdin = stdin;
            if let Err(e) = stdin.write_all(json.as_bytes()).await {
                eprintln!("Failed to write to stdin: {e}");
            }
            drop(stdin); // Close stdin
        });

        // Spawn stdout reader task
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let tx = event_tx.clone();
        tokio::spawn(async move {
            parse_agent_stdout(stdout, tx).await;
        });

        // Spawn stderr reader (log to debug, discard)
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(_line)) = lines.next_line().await {
                    // Silently consume stderr
                }
            });
        }

        Ok(Self { child: Some(child) })
    }

    /// Send a follow-up message via IPC input file.
    pub fn send_followup(config: &NanoClawConfig, text: &str) -> Result<(), String> {
        write_ipc_input(config, text)
    }

    /// Write the _close sentinel to end the agent session.
    pub fn close_session(config: &NanoClawConfig) -> Result<(), String> {
        let close_path = config.ipc_dir.join("input").join("_close");
        fs::write(&close_path, "")
            .map_err(|e| format!("Failed to write _close sentinel: {e}"))?;
        Ok(())
    }

    /// Kill the agent process.
    pub async fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.child = None;
    }

    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.child.is_some()
    }
}

/// Event produced by the marker parser for a single output block.
#[derive(Debug, PartialEq)]
pub enum ParsedEvent {
    /// Streaming partial text update
    Partial(String),
    /// Final result from agent
    Final(ContainerOutput),
    /// Parse error
    Error(String),
}

/// Stateful parser for agent-runner stdout marker protocol.
///
/// Processes lines one at a time, looking for
/// `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` pairs
/// and parsing the enclosed JSON as `ContainerOutput`.
pub struct MarkerParser {
    buffer: String,
    in_output_block: bool,
}

impl MarkerParser {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            in_output_block: false,
        }
    }

    /// Feed a single line to the parser. Returns an event if a complete output
    /// block was parsed, or None if more lines are needed.
    pub fn feed_line(&mut self, line: &str) -> Option<ParsedEvent> {
        if line.trim() == OUTPUT_START_MARKER {
            self.in_output_block = true;
            self.buffer.clear();
            return None;
        }
        if line.trim() == OUTPUT_END_MARKER {
            self.in_output_block = false;
            let json_str = self.buffer.trim().to_string();
            self.buffer.clear();
            if json_str.is_empty() {
                return None;
            }
            return match serde_json::from_str::<ContainerOutput>(&json_str) {
                Ok(output) => {
                    if output.partial.unwrap_or(false) {
                        if let Some(ref result) = output.result {
                            let text = strip_internal_tags(result);
                            let text = process_image_tags(&text);
                            if text.is_empty() {
                                None
                            } else {
                                Some(ParsedEvent::Partial(text))
                            }
                        } else {
                            None
                        }
                    } else {
                        Some(ParsedEvent::Final(output))
                    }
                }
                Err(e) => Some(ParsedEvent::Error(format!(
                    "Failed to parse agent output: {e}"
                ))),
            };
        }
        if self.in_output_block {
            if !self.buffer.is_empty() {
                self.buffer.push('\n');
            }
            self.buffer.push_str(line);
        }
        None
    }
}

/// Parse the agent-runner stdout for output markers.
async fn parse_agent_stdout(
    stdout: tokio::process::ChildStdout,
    tx: mpsc::UnboundedSender<AppEvent>,
) {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut parser = MarkerParser::new();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if let Some(event) = parser.feed_line(&line) {
                    let app_event = match event {
                        ParsedEvent::Partial(text) => AppEvent::AgentPartial(text),
                        ParsedEvent::Final(output) => AppEvent::AgentFinal(output),
                        ParsedEvent::Error(e) => AppEvent::AgentError(e),
                    };
                    let _ = tx.send(app_event);
                }
            }
            Ok(None) => {
                let _ = tx.send(AppEvent::AgentExited(None));
                break;
            }
            Err(e) => {
                let _ = tx.send(AppEvent::AgentError(format!("Stdout read error: {e}")));
                break;
            }
        }
    }
}

/// Ensure required IPC and group directories exist.
fn ensure_dirs(config: &NanoClawConfig) -> Result<(), String> {
    let dirs = [
        config.ipc_dir.join("messages"),
        config.ipc_dir.join("tasks"),
        config.ipc_dir.join("input"),
        config.group_dir.clone(),
        config.global_dir.clone(),
        config.extra_dir.clone(),
        config.claude_home.clone(),
    ];
    for d in &dirs {
        fs::create_dir_all(d).map_err(|e| format!("Failed to create {}: {e}", d.display()))?;
    }
    Ok(())
}

/// Build environment variables matching host-runner.ts buildEnvironment().
fn build_env(config: &NanoClawConfig) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();

    // Auth credentials from .env
    for (k, v) in &config.env_vars {
        env.insert(k.clone(), v.clone());
    }

    // NanoClaw workspace paths
    env.insert(
        "NANOCLAW_IPC_DIR".to_string(),
        config.ipc_dir.to_string_lossy().to_string(),
    );
    env.insert(
        "NANOCLAW_GROUP_DIR".to_string(),
        config.group_dir.to_string_lossy().to_string(),
    );
    env.insert(
        "NANOCLAW_GLOBAL_DIR".to_string(),
        config.global_dir.to_string_lossy().to_string(),
    );
    env.insert(
        "NANOCLAW_EXTRA_DIR".to_string(),
        config.extra_dir.to_string_lossy().to_string(),
    );
    env.insert("NANOCLAW_CHAT_JID".to_string(), config.group_jid.clone());
    env.insert(
        "NANOCLAW_GROUP_FOLDER".to_string(),
        config.group_folder.clone(),
    );
    env.insert(
        "NANOCLAW_IS_MAIN".to_string(),
        if config.is_main { "1" } else { "0" }.to_string(),
    );

    let claude_path = crate::config::find_claude_path();
    if !claude_path.is_empty() {
        env.insert("CLAUDE_CODE_PATH".to_string(), claude_path);
    }
    env.insert(
        "CLAUDE_CONFIG_DIR".to_string(),
        config.claude_home.to_string_lossy().to_string(),
    );
    env.insert("TZ".to_string(), config.timezone.clone());

    env
}

/// Write a follow-up message to the IPC input directory (atomic write).
fn write_ipc_input(config: &NanoClawConfig, text: &str) -> Result<(), String> {
    let input_dir = config.ipc_dir.join("input");
    fs::create_dir_all(&input_dir)
        .map_err(|e| format!("Failed to create IPC input dir: {e}"))?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random: u32 = rand::random();
    let filename = format!("{timestamp}-{random:08x}.json");
    let filepath = input_dir.join(&filename);
    let temp_path = PathBuf::from(format!("{}.tmp", filepath.display()));

    let content = serde_json::json!({
        "type": "message",
        "text": text,
    });
    fs::write(&temp_path, content.to_string())
        .map_err(|e| format!("Failed to write IPC file: {e}"))?;
    fs::rename(&temp_path, &filepath)
        .map_err(|e| format!("Failed to rename IPC file: {e}"))?;
    Ok(())
}

/// Strip <internal>...</internal> tags from agent output.
pub fn strip_internal_tags(text: &str) -> String {
    // Strip complete <internal>...</internal> pairs
    let re_complete = Regex::new(r"(?s)<internal>.*?</internal>").unwrap();
    let text = re_complete.replace_all(text, "");
    // Strip unclosed <internal> at end
    let re_unclosed = Regex::new(r"(?s)<internal>.*$").unwrap();
    let text = re_unclosed.replace_all(&text, "");
    // Strip partial opening tag at end
    let re_partial = Regex::new(r"<int(?:e(?:r(?:n(?:a(?:l)?)?)?)?)?$").unwrap();
    re_partial.replace_all(&text, "").trim().to_string()
}

/// Replace <image> tags with [#image filename] display format.
pub fn process_image_tags(text: &str) -> String {
    let re = Regex::new(r#"<image\s+path="([^"]+)"(?:\s+caption="([^"]*)")?\s*/>"#).unwrap();
    re.replace_all(text, |caps: &regex::Captures| {
        let path = Path::new(&caps[1]);
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        match caps.get(2) {
            Some(caption) if !caption.as_str().is_empty() => {
                format!("[#image {} - {}]", filename, caption.as_str())
            }
            _ => format!("[#image {}]", filename),
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- strip_internal_tags ---

    #[test]
    fn test_strip_internal_tags_complete() {
        let input = "Hello <internal>secret stuff</internal> world";
        assert_eq!(strip_internal_tags(input), "Hello  world");
    }

    #[test]
    fn test_strip_internal_tags_unclosed() {
        let input = "Hello <internal>still writing...";
        assert_eq!(strip_internal_tags(input), "Hello");
    }

    #[test]
    fn test_strip_internal_tags_partial_opening() {
        let input = "Hello <inter";
        assert_eq!(strip_internal_tags(input), "Hello");
    }

    #[test]
    fn test_strip_internal_tags_partial_int() {
        let input = "Hello <int";
        assert_eq!(strip_internal_tags(input), "Hello");
    }

    #[test]
    fn test_strip_internal_tags_nested() {
        // Non-greedy match: strips <internal>B <internal>C</internal>, leaves " D</internal> E"
        let input = "A <internal>B <internal>C</internal> D</internal> E";
        let result = strip_internal_tags(input);
        assert_eq!(result, "A  D</internal> E");
    }

    #[test]
    fn test_strip_internal_tags_empty() {
        assert_eq!(strip_internal_tags(""), "");
    }

    #[test]
    fn test_strip_internal_tags_no_tags() {
        assert_eq!(strip_internal_tags("Just plain text"), "Just plain text");
    }

    #[test]
    fn test_strip_internal_tags_multiline() {
        let input = "Before\n<internal>\nline1\nline2\n</internal>\nAfter";
        assert_eq!(strip_internal_tags(input), "Before\n\nAfter");
    }

    // --- process_image_tags ---

    #[test]
    fn test_process_image_tags_with_caption() {
        let input = r#"Look: <image path="/workspace/group/photo.jpg" caption="A nice photo" />"#;
        assert_eq!(
            process_image_tags(input),
            "Look: [#image photo.jpg - A nice photo]"
        );
    }

    #[test]
    fn test_process_image_tags_without_caption() {
        let input = r#"Here: <image path="/tmp/screenshot.png" />"#;
        assert_eq!(process_image_tags(input), "Here: [#image screenshot.png]");
    }

    #[test]
    fn test_process_image_tags_empty_caption() {
        let input = r#"<image path="/tmp/file.jpg" caption="" />"#;
        assert_eq!(process_image_tags(input), "[#image file.jpg]");
    }

    #[test]
    fn test_process_image_tags_multiple() {
        let input = r#"<image path="/a/b.png" /> and <image path="/c/d.jpg" caption="test" />"#;
        assert_eq!(
            process_image_tags(input),
            "[#image b.png] and [#image d.jpg - test]"
        );
    }

    #[test]
    fn test_process_image_tags_no_images() {
        let input = "Just text without images";
        assert_eq!(process_image_tags(input), "Just text without images");
    }

    #[test]
    fn test_process_image_tags_special_chars_in_path() {
        let input = r#"<image path="/tmp/my file (1).png" />"#;
        assert_eq!(process_image_tags(input), "[#image my file (1).png]");
    }

    // --- ContainerInput serialization ---

    #[test]
    fn test_container_input_serialization_full() {
        let input = ContainerInput {
            prompt: "Hello".to_string(),
            session_id: Some("sess-123".to_string()),
            group_folder: "telegram_main".to_string(),
            chat_jid: "tg:123".to_string(),
            is_main: true,
            assistant_name: Some("Andy".to_string()),
            model: Some("claude-opus-4-20250514".to_string()),
            effort: Some("high".to_string()),
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["prompt"], "Hello");
        assert_eq!(json["sessionId"], "sess-123");
        assert_eq!(json["groupFolder"], "telegram_main");
        assert_eq!(json["chatJid"], "tg:123");
        assert_eq!(json["isMain"], true);
        assert_eq!(json["assistantName"], "Andy");
        assert_eq!(json["model"], "claude-opus-4-20250514");
        assert_eq!(json["effort"], "high");
    }

    #[test]
    fn test_container_input_serialization_minimal() {
        let input = ContainerInput {
            prompt: "Hello".to_string(),
            session_id: None,
            group_folder: "test".to_string(),
            chat_jid: "tg:123".to_string(),
            is_main: false,
            assistant_name: None,
            model: None,
            effort: None,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["prompt"], "Hello");
        assert!(json.get("sessionId").is_none());
        assert!(json.get("assistantName").is_none());
        assert!(json.get("model").is_none());
        assert!(json.get("effort").is_none());
    }

    // --- ContainerOutput deserialization ---

    #[test]
    fn test_container_output_partial() {
        let json = r#"{"status":"success","result":"Streaming text...","partial":true,"newSessionId":"sess-123"}"#;
        let output: ContainerOutput = serde_json::from_str(json).unwrap();
        assert_eq!(output.status, "success");
        assert_eq!(output.result.unwrap(), "Streaming text...");
        assert!(output.partial.unwrap());
        assert_eq!(output.new_session_id.unwrap(), "sess-123");
    }

    #[test]
    fn test_container_output_final() {
        let json = r#"{"status":"success","result":"Final answer","newSessionId":"sess-123","usage":{"inputTokens":100,"outputTokens":50,"numTurns":1},"contextWindow":200000}"#;
        let output: ContainerOutput = serde_json::from_str(json).unwrap();
        assert_eq!(output.status, "success");
        assert!(output.partial.is_none());
        let usage = output.usage.unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.num_turns, 1);
        assert_eq!(output.context_window.unwrap(), 200000);
    }

    #[test]
    fn test_container_output_session_update() {
        let json = r#"{"status":"success","result":null,"newSessionId":"sess-456"}"#;
        let output: ContainerOutput = serde_json::from_str(json).unwrap();
        assert!(output.result.is_none());
        assert_eq!(output.new_session_id.unwrap(), "sess-456");
    }

    #[test]
    fn test_container_output_error() {
        let json = r#"{"status":"error","result":null,"error":"Something went wrong"}"#;
        let output: ContainerOutput = serde_json::from_str(json).unwrap();
        assert_eq!(output.status, "error");
        assert_eq!(output.error.unwrap(), "Something went wrong");
    }

    #[test]
    fn test_container_output_compacted() {
        let json = r#"{"status":"success","result":null,"newSessionId":"sess-789","compacted":true}"#;
        let output: ContainerOutput = serde_json::from_str(json).unwrap();
        assert!(output.compacted.unwrap());
    }

    // --- MarkerParser ---

    #[test]
    fn test_marker_parser_partial() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line("some noise").is_none());
        assert!(parser.feed_line(OUTPUT_START_MARKER).is_none());
        assert!(parser
            .feed_line(r#"{"status":"success","result":"Hello","partial":true}"#)
            .is_none());
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        assert_eq!(event, ParsedEvent::Partial("Hello".to_string()));
    }

    #[test]
    fn test_marker_parser_final() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line(OUTPUT_START_MARKER).is_none());
        assert!(parser
            .feed_line(r#"{"status":"success","result":"Done","newSessionId":"s1"}"#)
            .is_none());
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match event {
            ParsedEvent::Final(output) => {
                assert_eq!(output.result.as_deref(), Some("Done"));
                assert_eq!(output.new_session_id.as_deref(), Some("s1"));
            }
            _ => panic!("Expected Final"),
        }
    }

    #[test]
    fn test_marker_parser_session_update_no_result() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line(OUTPUT_START_MARKER).is_none());
        assert!(parser
            .feed_line(r#"{"status":"success","result":null,"newSessionId":"s2"}"#)
            .is_none());
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match event {
            ParsedEvent::Final(output) => {
                assert!(output.result.is_none());
                assert_eq!(output.new_session_id.as_deref(), Some("s2"));
            }
            _ => panic!("Expected Final for session update"),
        }
    }

    #[test]
    fn test_marker_parser_malformed_json() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line(OUTPUT_START_MARKER).is_none());
        assert!(parser.feed_line("not valid json").is_none());
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match event {
            ParsedEvent::Error(msg) => assert!(msg.contains("Failed to parse")),
            _ => panic!("Expected Error"),
        }
    }

    #[test]
    fn test_marker_parser_empty_block() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line(OUTPUT_START_MARKER).is_none());
        assert!(parser.feed_line(OUTPUT_END_MARKER).is_none()); // empty block -> None
    }

    #[test]
    fn test_marker_parser_multiple_outputs() {
        let mut parser = MarkerParser::new();

        // First output (partial)
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(r#"{"status":"success","result":"Part 1","partial":true}"#);
        let e1 = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        assert_eq!(e1, ParsedEvent::Partial("Part 1".to_string()));

        // Second output (final)
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(r#"{"status":"success","result":"Final"}"#);
        let e2 = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match e2 {
            ParsedEvent::Final(o) => assert_eq!(o.result.as_deref(), Some("Final")),
            _ => panic!("Expected Final"),
        }
    }

    #[test]
    fn test_marker_parser_multiline_json() {
        let mut parser = MarkerParser::new();
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(r#"{"status":"success","#);
        parser.feed_line(r#""result":"Multi-line"}"#);
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match event {
            ParsedEvent::Final(o) => assert_eq!(o.result.as_deref(), Some("Multi-line")),
            _ => panic!("Expected Final"),
        }
    }

    #[test]
    fn test_marker_parser_partial_with_internal_tags() {
        let mut parser = MarkerParser::new();
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(
            r#"{"status":"success","result":"Hello <internal>secret</internal> world","partial":true}"#,
        );
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        assert_eq!(event, ParsedEvent::Partial("Hello  world".to_string()));
    }

    #[test]
    fn test_marker_parser_partial_with_images() {
        let mut parser = MarkerParser::new();
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(
            r#"{"status":"success","result":"See: <image path=\"/tmp/pic.png\" />","partial":true}"#,
        );
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        assert_eq!(event, ParsedEvent::Partial("See: [#image pic.png]".to_string()));
    }

    #[test]
    fn test_marker_parser_partial_empty_after_strip() {
        let mut parser = MarkerParser::new();
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(
            r#"{"status":"success","result":"<internal>only internal</internal>","partial":true}"#,
        );
        // Result is empty after stripping -> None
        assert!(parser.feed_line(OUTPUT_END_MARKER).is_none());
    }

    #[test]
    fn test_marker_parser_partial_null_result() {
        let mut parser = MarkerParser::new();
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(r#"{"status":"success","result":null,"partial":true}"#);
        // Null result on partial -> None
        assert!(parser.feed_line(OUTPUT_END_MARKER).is_none());
    }

    #[test]
    fn test_marker_parser_lines_outside_markers_ignored() {
        let mut parser = MarkerParser::new();
        // Lines before markers
        assert!(parser.feed_line("random noise").is_none());
        assert!(parser.feed_line("more noise").is_none());
        // Now a valid block
        parser.feed_line(OUTPUT_START_MARKER);
        parser.feed_line(r#"{"status":"success","result":"OK"}"#);
        let event = parser.feed_line(OUTPUT_END_MARKER).unwrap();
        match event {
            ParsedEvent::Final(o) => assert_eq!(o.result.as_deref(), Some("OK")),
            _ => panic!("Expected Final"),
        }
    }

    #[test]
    fn test_marker_parser_whitespace_around_markers() {
        let mut parser = MarkerParser::new();
        assert!(parser.feed_line("  ---NANOCLAW_OUTPUT_START---  ").is_none());
        parser.feed_line(r#"{"status":"success","result":"trimmed"}"#);
        let event = parser.feed_line("  ---NANOCLAW_OUTPUT_END---  ").unwrap();
        match event {
            ParsedEvent::Final(o) => assert_eq!(o.result.as_deref(), Some("trimmed")),
            _ => panic!("Expected Final"),
        }
    }

    // --- ensure_dirs ---

    #[test]
    fn test_ensure_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let config = NanoClawConfig {
            project_root: dir.path().to_path_buf(),
            group_folder: "test_group".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: dir.path().join("ipc"),
            group_dir: dir.path().join("group"),
            global_dir: dir.path().join("global"),
            extra_dir: dir.path().join("extra"),
            claude_home: dir.path().join("claude"),
            agent_runner_entry: dir.path().to_path_buf(),
            db_path: dir.path().to_path_buf(),
            env_vars: HashMap::new(),
            model_aliases: HashMap::new(),
        };

        ensure_dirs(&config).unwrap();

        assert!(dir.path().join("ipc/messages").exists());
        assert!(dir.path().join("ipc/tasks").exists());
        assert!(dir.path().join("ipc/input").exists());
        assert!(dir.path().join("group").exists());
        assert!(dir.path().join("global").exists());
        assert!(dir.path().join("extra").exists());
        assert!(dir.path().join("claude").exists());
    }

    // --- build_env ---

    #[test]
    fn test_build_env() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut env_vars = HashMap::new();
        env_vars.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "test-token".to_string());

        let config = NanoClawConfig {
            project_root: dir.path().to_path_buf(),
            group_folder: "telegram_main".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "Main Group".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "Asia/Tokyo".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: dir.path().join("ipc"),
            group_dir: dir.path().join("group"),
            global_dir: dir.path().join("global"),
            extra_dir: dir.path().join("extra"),
            claude_home: dir.path().join("claude"),
            agent_runner_entry: dir.path().to_path_buf(),
            db_path: dir.path().to_path_buf(),
            env_vars,
            model_aliases: HashMap::new(),
        };

        let env = build_env(&config);

        assert_eq!(env.get("NANOCLAW_IPC_DIR").unwrap(), &dir.path().join("ipc").to_string_lossy().to_string());
        assert_eq!(env.get("NANOCLAW_GROUP_DIR").unwrap(), &dir.path().join("group").to_string_lossy().to_string());
        assert_eq!(env.get("NANOCLAW_GLOBAL_DIR").unwrap(), &dir.path().join("global").to_string_lossy().to_string());
        assert_eq!(env.get("NANOCLAW_EXTRA_DIR").unwrap(), &dir.path().join("extra").to_string_lossy().to_string());
        assert_eq!(env.get("NANOCLAW_CHAT_JID").unwrap(), "tg:123");
        assert_eq!(env.get("NANOCLAW_GROUP_FOLDER").unwrap(), "telegram_main");
        assert_eq!(env.get("NANOCLAW_IS_MAIN").unwrap(), "1");
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").unwrap(), &dir.path().join("claude").to_string_lossy().to_string());
        assert_eq!(env.get("TZ").unwrap(), "Asia/Tokyo");
        assert_eq!(env.get("CLAUDE_CODE_OAUTH_TOKEN").unwrap(), "test-token");
    }

    #[test]
    fn test_build_env_not_main() {
        let dir = tempfile::TempDir::new().unwrap();
        let config = NanoClawConfig {
            project_root: dir.path().to_path_buf(),
            group_folder: "dev".to_string(),
            group_jid: "tg:456".to_string(),
            group_name: "Dev".to_string(),
            is_main: false,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: dir.path().join("ipc"),
            group_dir: dir.path().join("group"),
            global_dir: dir.path().join("global"),
            extra_dir: dir.path().join("extra"),
            claude_home: dir.path().join("claude"),
            agent_runner_entry: dir.path().to_path_buf(),
            db_path: dir.path().to_path_buf(),
            env_vars: HashMap::new(),
            model_aliases: HashMap::new(),
        };

        let env = build_env(&config);
        assert_eq!(env.get("NANOCLAW_IS_MAIN").unwrap(), "0");
    }

    // --- IPC file write ---

    #[test]
    fn test_write_ipc_input() {
        let dir = tempfile::TempDir::new().unwrap();
        let ipc_dir = dir.path().join("ipc").join("test_group");
        let config = NanoClawConfig {
            project_root: dir.path().to_path_buf(),
            group_folder: "test_group".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: ipc_dir.clone(),
            group_dir: dir.path().to_path_buf(),
            global_dir: dir.path().to_path_buf(),
            extra_dir: dir.path().to_path_buf(),
            claude_home: dir.path().to_path_buf(),
            agent_runner_entry: dir.path().to_path_buf(),
            db_path: dir.path().to_path_buf(),
            env_vars: HashMap::new(),
            model_aliases: HashMap::new(),
        };

        write_ipc_input(&config, "Hello from TUI").unwrap();

        // Verify file was created
        let input_dir = ipc_dir.join("input");
        let files: Vec<_> = fs::read_dir(&input_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
            .collect();
        assert_eq!(files.len(), 1);

        // Verify content
        let content = fs::read_to_string(files[0].path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "message");
        assert_eq!(parsed["text"], "Hello from TUI");

        // Verify no .tmp file remains
        let tmp_files: Vec<_> = fs::read_dir(&input_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "tmp"))
            .collect();
        assert!(tmp_files.is_empty());
    }
}
