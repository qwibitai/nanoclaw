use chrono::Local;

use crate::agent::{self, AgentHandle, ContainerInput, ContainerOutput, Usage};
use crate::commands::{self, CommandResult};
use crate::config::NanoClawConfig;
use crate::db;
use crate::event::AppEvent;

/// Agent lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AgentState {
    Idle,
    Running,
    WaitingIpc,
}

impl std::fmt::Display for AgentState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentState::Idle => write!(f, "Idle"),
            AgentState::Running => write!(f, "Running"),
            AgentState::WaitingIpc => write!(f, "WaitingIpc"),
        }
    }
}

/// Role of a chat message.
#[derive(Debug, Clone, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Splitter,
}

/// A single message in the chat display.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    pub timestamp: String,
    pub is_streaming: bool,
    pub is_history: bool,
}

/// State for the slash command suggestion popup.
#[derive(Debug, Clone)]
pub struct SuggestionState {
    /// Filtered list of (command_name, description) pairs.
    pub items: Vec<(&'static str, &'static str)>,
    /// Currently selected index.
    pub selected: usize,
}

/// Main application state.
pub struct AppState {
    pub messages: Vec<ChatMessage>,
    pub input_buffer: String,
    pub cursor_pos: usize,
    pub suggestion: Option<SuggestionState>,
    pub scroll_offset: usize,
    pub auto_scroll: bool,
    pub session_id: Option<String>,
    pub agent_state: AgentState,
    pub config: NanoClawConfig,
    pub last_usage: Option<Usage>,
    pub context_window: Option<u64>,
    pub should_quit: bool,
    pub agent_handle: Option<AgentHandle>,
    pub event_tx: tokio::sync::mpsc::UnboundedSender<AppEvent>,
    pub last_db_message_ts: Option<String>,
}

impl AppState {
    pub fn new(
        config: NanoClawConfig,
        event_tx: tokio::sync::mpsc::UnboundedSender<AppEvent>,
    ) -> Self {
        // Load existing session from DB
        let session_id = db::open_readonly(&config.db_path)
            .ok()
            .and_then(|conn| db::get_session(&conn, &config.group_folder));

        Self {
            messages: Vec::new(),
            input_buffer: String::new(),
            cursor_pos: 0,
            suggestion: None,
            scroll_offset: 0,
            auto_scroll: true,
            session_id,
            agent_state: AgentState::Idle,
            config,
            last_usage: None,
            context_window: None,
            should_quit: false,
            agent_handle: None,
            event_tx,
            last_db_message_ts: None,
        }
    }

    /// Add a user message and trigger agent invocation.
    pub async fn submit_message(&mut self) {
        let text = self.input_buffer.trim().to_string();
        if text.is_empty() {
            return;
        }

        self.input_buffer.clear();
        self.cursor_pos = 0;
        self.suggestion = None;

        // Handle slash commands
        if text.starts_with('/') {
            let result = commands::dispatch(
                &text,
                &self.config,
                &self.session_id,
                &self.last_usage,
                &self.context_window,
                &self.agent_state.to_string(),
            );
            match result {
                CommandResult::SystemMessage(msg) => {
                    self.add_system_message(&msg);
                }
                CommandResult::SendToAgent(ipc_text) => {
                    if self.agent_state != AgentState::Idle {
                        if let Err(e) = AgentHandle::send_followup(&self.config, &ipc_text) {
                            self.add_system_message(&format!("Error: {e}"));
                        }
                    }
                }
                CommandResult::ClearSession => {
                    self.clear_session().await;
                }
                CommandResult::Quit => {
                    self.should_quit = true;
                }
                CommandResult::Unknown(cmd) => {
                    self.add_system_message(&format!("Unknown command: {cmd}"));
                }
            }
            return;
        }

        // Add user message to display
        self.add_user_message(&text);

        // Send to agent
        match self.agent_state {
            AgentState::Idle => {
                self.spawn_agent(&text).await;
            }
            AgentState::WaitingIpc => {
                if let Err(e) = AgentHandle::send_followup(&self.config, &text) {
                    self.add_system_message(&format!("Error sending follow-up: {e}"));
                } else {
                    self.agent_state = AgentState::Running;
                }
            }
            AgentState::Running => {
                // Agent is busy, queue as IPC input anyway
                if let Err(e) = AgentHandle::send_followup(&self.config, &text) {
                    self.add_system_message(&format!("Error sending message: {e}"));
                }
            }
        }

        self.auto_scroll = true;
    }

    /// Spawn a new agent-runner process.
    async fn spawn_agent(&mut self, prompt: &str) {
        // Reload model/effort from DB in case they changed
        if let Ok(conn) = db::open_readonly(&self.config.db_path) {
            if let Ok(group) = db::find_group(&conn, &self.config.group_folder) {
                self.config.model = group.model;
                self.config.effort = group.effort;
            }
        }

        let input = ContainerInput {
            prompt: prompt.to_string(),
            session_id: self.session_id.clone(),
            group_folder: self.config.group_folder.clone(),
            chat_jid: self.config.group_jid.clone(),
            is_main: self.config.is_main,
            assistant_name: Some(self.config.assistant_name.clone()),
            model: self.config.model.clone(),
            effort: self.config.effort.clone(),
        };

        match AgentHandle::spawn(&self.config, input, self.event_tx.clone()).await {
            Ok(handle) => {
                self.agent_handle = Some(handle);
                self.agent_state = AgentState::Running;
            }
            Err(e) => {
                self.add_system_message(&format!("Failed to start agent: {e}"));
                self.agent_state = AgentState::Idle;
            }
        }
    }

    /// Handle streaming partial text update.
    pub fn update_streaming(&mut self, text: String) {
        // If last message is a streaming assistant message, update it
        if let Some(last) = self.messages.last_mut() {
            if last.role == MessageRole::Assistant && last.is_streaming {
                last.content = text;
                if self.auto_scroll {
                    self.scroll_offset = 0;
                }
                return;
            }
        }

        // Otherwise, create a new streaming message
        self.messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content: text,
            timestamp: Local::now().format("%H:%M").to_string(),
            is_streaming: true,
            is_history: false,
        });
        if self.auto_scroll {
            self.scroll_offset = 0;
        }
    }

    /// Finalize the current agent response.
    pub fn finalize(&mut self, output: ContainerOutput) {
        // Update session ID
        if let Some(ref new_id) = output.new_session_id {
            self.session_id = Some(new_id.clone());
            let _ = db::set_session(
                &self.config.db_path,
                &self.config.group_folder,
                new_id,
            );
        }

        // Update usage
        if let Some(ref usage) = output.usage {
            self.last_usage = Some(usage.clone());
        }
        if let Some(cw) = output.context_window {
            self.context_window = Some(cw);
        }

        // Handle compacted notification
        if output.compacted.unwrap_or(false) {
            self.add_system_message("Context compacted");
        }

        // Handle result text
        if let Some(ref result) = output.result {
            let text = agent::strip_internal_tags(result);
            let text = agent::process_image_tags(&text);

            if !text.is_empty() {
                // If last message is streaming, finalize it
                if let Some(last) = self.messages.last_mut() {
                    if last.role == MessageRole::Assistant && last.is_streaming {
                        last.content = text;
                        last.is_streaming = false;
                        self.agent_state = AgentState::WaitingIpc;
                        if self.auto_scroll {
                            self.scroll_offset = 0;
                        }
                        return;
                    }
                }

                // No streaming message — create final message
                self.messages.push(ChatMessage {
                    role: MessageRole::Assistant,
                    content: text,
                    timestamp: Local::now().format("%H:%M").to_string(),
                    is_streaming: false,
                    is_history: false,
                });
            }
        }

        // Handle error
        if output.status == "error" {
            if let Some(ref err) = output.error {
                self.add_system_message(&format!("Agent error: {err}"));
            }
        }

        self.agent_state = AgentState::WaitingIpc;
        if self.auto_scroll {
            self.scroll_offset = 0;
        }
    }

    /// Handle agent process exit.
    pub fn on_agent_exit(&mut self, code: Option<i32>) {
        // Finalize any streaming message
        if let Some(last) = self.messages.last_mut() {
            if last.role == MessageRole::Assistant && last.is_streaming {
                last.is_streaming = false;
            }
        }

        self.agent_state = AgentState::Idle;
        self.agent_handle = None;

        if let Some(c) = code {
            if c != 0 {
                self.add_system_message(&format!("Agent exited with code {c}"));
            }
        }
    }

    /// Clear the current session.
    async fn clear_session(&mut self) {
        // Close agent if running
        if self.agent_state != AgentState::Idle {
            let _ = AgentHandle::close_session(&self.config);
            if let Some(ref mut handle) = self.agent_handle {
                // Give it a moment then kill
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                handle.kill().await;
            }
        }

        // Delete session from DB
        let _ = db::delete_session(&self.config.db_path, &self.config.group_folder);

        self.session_id = None;
        self.agent_state = AgentState::Idle;
        self.agent_handle = None;
        self.last_usage = None;
        self.context_window = None;
        self.add_system_message("Session cleared");
    }

    /// Graceful shutdown.
    pub async fn shutdown(&mut self) {
        if self.agent_state != AgentState::Idle {
            let _ = AgentHandle::close_session(&self.config);
            if let Some(ref mut handle) = self.agent_handle {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                handle.kill().await;
            }
        }
    }

    fn add_user_message(&mut self, text: &str) {
        self.messages.push(ChatMessage {
            role: MessageRole::User,
            content: text.to_string(),
            timestamp: Local::now().format("%H:%M").to_string(),
            is_streaming: false,
            is_history: false,
        });
    }

    pub fn add_system_message(&mut self, text: &str) {
        self.messages.push(ChatMessage {
            role: MessageRole::System,
            content: text.to_string(),
            timestamp: Local::now().format("%H:%M").to_string(),
            is_streaming: false,
            is_history: false,
        });
        if self.auto_scroll {
            self.scroll_offset = 0;
        }
    }

    /// Add a history message (loaded from DB) with proper role.
    pub fn add_history_message(&mut self, role: MessageRole, content: &str) {
        self.messages.push(ChatMessage {
            role,
            content: content.to_string(),
            timestamp: String::new(),
            is_streaming: false,
            is_history: true,
        });
    }

    /// Add a visual splitter between history and live session.
    pub fn add_splitter(&mut self) {
        self.messages.push(ChatMessage {
            role: MessageRole::Splitter,
            content: String::new(),
            timestamp: String::new(),
            is_streaming: false,
            is_history: false,
        });
    }

    /// Process new messages from DB polling.
    pub fn on_new_db_messages(&mut self, messages: Vec<db::MessageRow>) {
        if messages.is_empty() {
            return;
        }
        let group_name = self.config.group_name.clone();
        for m in &messages {
            let role = if m.is_bot_message {
                MessageRole::Assistant
            } else {
                MessageRole::User
            };
            let sender = if m.is_bot_message {
                &group_name
            } else {
                &m.sender_name
            };
            let time = db::format_local_time(&m.timestamp);
            let content = format!("[{}] {}: {}", time, sender, m.content);
            self.add_history_message(role, &content);
        }
        if let Some(last) = messages.last() {
            self.last_db_message_ts = Some(last.timestamp.clone());
        }
        if self.auto_scroll {
            self.scroll_offset = 0;
        }
    }

    // --- Input editing ---

    pub fn insert_char(&mut self, c: char) {
        self.input_buffer.insert(self.cursor_pos, c);
        self.cursor_pos += c.len_utf8();
        self.update_suggestions();
    }

    pub fn delete_char_before(&mut self) {
        if self.cursor_pos > 0 {
            // Find the previous char boundary
            let prev = self.input_buffer[..self.cursor_pos]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.input_buffer.drain(prev..self.cursor_pos);
            self.cursor_pos = prev;
        }
        self.update_suggestions();
    }

    pub fn delete_char_after(&mut self) {
        if self.cursor_pos < self.input_buffer.len() {
            let next = self.input_buffer[self.cursor_pos..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.cursor_pos + i)
                .unwrap_or(self.input_buffer.len());
            self.input_buffer.drain(self.cursor_pos..next);
        }
        self.update_suggestions();
    }

    pub fn move_cursor_left(&mut self) {
        if self.cursor_pos > 0 {
            self.cursor_pos = self.input_buffer[..self.cursor_pos]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
        }
    }

    pub fn move_cursor_right(&mut self) {
        if self.cursor_pos < self.input_buffer.len() {
            self.cursor_pos = self.input_buffer[self.cursor_pos..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.cursor_pos + i)
                .unwrap_or(self.input_buffer.len());
        }
    }

    pub fn move_cursor_home(&mut self) {
        self.cursor_pos = 0;
    }

    pub fn move_cursor_end(&mut self) {
        self.cursor_pos = self.input_buffer.len();
    }

    pub fn clear_line(&mut self) {
        self.input_buffer.clear();
        self.cursor_pos = 0;
        self.suggestion = None;
    }

    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
        self.auto_scroll = false;
    }

    pub fn scroll_down(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
        if self.scroll_offset == 0 {
            self.auto_scroll = true;
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.auto_scroll = true;
    }

    // --- Slash command suggestions ---

    /// Recompute the suggestion list based on current input_buffer.
    fn update_suggestions(&mut self) {
        if !self.input_buffer.starts_with('/') || self.input_buffer.contains(' ') {
            self.suggestion = None;
            return;
        }

        let prefix = &self.input_buffer;
        let items: Vec<(&'static str, &'static str)> = commands::COMMANDS
            .iter()
            .filter(|cmd| cmd.name.starts_with(prefix))
            .map(|cmd| (cmd.name, cmd.description))
            .collect();

        if items.is_empty() {
            self.suggestion = None;
        } else {
            let old_selected = self.suggestion.as_ref().map_or(0, |s| s.selected);
            self.suggestion = Some(SuggestionState {
                selected: old_selected.min(items.len().saturating_sub(1)),
                items,
            });
        }
    }

    pub fn suggestion_up(&mut self) {
        if let Some(ref mut s) = self.suggestion {
            s.selected = s.selected.saturating_sub(1);
        }
    }

    pub fn suggestion_down(&mut self) {
        if let Some(ref mut s) = self.suggestion {
            if s.selected + 1 < s.items.len() {
                s.selected += 1;
            }
        }
    }

    /// Accept the selected suggestion: replace input with command name.
    /// Does NOT submit the message.
    pub fn suggestion_accept(&mut self) {
        if let Some(ref s) = self.suggestion {
            if let Some(&(name, _)) = s.items.get(s.selected) {
                self.input_buffer = name.to_string();
                self.cursor_pos = self.input_buffer.len();
            }
        }
        self.suggestion = None;
    }

    pub fn suggestion_dismiss(&mut self) {
        self.suggestion = None;
    }

    pub fn has_suggestions(&self) -> bool {
        self.suggestion.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn make_app() -> AppState {
        let (tx, _rx) = mpsc::unbounded_channel();
        let config = NanoClawConfig {
            project_root: std::path::PathBuf::from("/tmp"),
            group_folder: "test".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: std::path::PathBuf::from("/tmp"),
            group_dir: std::path::PathBuf::from("/tmp"),
            global_dir: std::path::PathBuf::from("/tmp"),
            extra_dir: std::path::PathBuf::from("/tmp"),
            claude_home: std::path::PathBuf::from("/tmp"),
            agent_runner_entry: std::path::PathBuf::from("/tmp"),
            db_path: std::path::PathBuf::from("/tmp/nonexistent.db"),
            env_vars: std::collections::HashMap::new(),
            model_aliases: std::collections::HashMap::new(),
        };
        AppState::new(config, tx)
    }

    #[test]
    fn test_add_user_message() {
        let mut app = make_app();
        app.add_user_message("Hello");
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].role, MessageRole::User);
        assert_eq!(app.messages[0].content, "Hello");
    }

    #[test]
    fn test_update_streaming_new() {
        let mut app = make_app();
        app.update_streaming("Partial text".to_string());
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].role, MessageRole::Assistant);
        assert!(app.messages[0].is_streaming);
    }

    #[test]
    fn test_update_streaming_update() {
        let mut app = make_app();
        app.update_streaming("Partial".to_string());
        app.update_streaming("Partial text extended".to_string());
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].content, "Partial text extended");
        assert!(app.messages[0].is_streaming);
    }

    #[test]
    fn test_finalize() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;
        app.update_streaming("Streaming...".to_string());

        let output = ContainerOutput {
            status: "success".to_string(),
            result: Some("Final answer".to_string()),
            new_session_id: Some("sess-123".to_string()),
            error: None,
            partial: None,
            usage: Some(Usage {
                input_tokens: 100,
                output_tokens: 50,
                num_turns: 1,
            }),
            context_window: Some(200000),
            compacted: None,
        };

        app.finalize(output);

        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].content, "Final answer");
        assert!(!app.messages[0].is_streaming);
        assert_eq!(app.session_id.as_deref(), Some("sess-123"));
        assert_eq!(app.agent_state, AgentState::WaitingIpc);
        assert!(app.last_usage.is_some());
        assert_eq!(app.context_window, Some(200000));
    }

    #[test]
    fn test_finalize_with_images() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;

        let output = ContainerOutput {
            status: "success".to_string(),
            result: Some(r#"Here: <image path="/tmp/photo.jpg" caption="test" />"#.to_string()),
            new_session_id: None,
            error: None,
            partial: None,
            usage: None,
            context_window: None,
            compacted: None,
        };

        app.finalize(output);

        assert_eq!(app.messages.last().unwrap().content, "Here: [#image photo.jpg - test]");
    }

    #[test]
    fn test_finalize_error() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;

        let output = ContainerOutput {
            status: "error".to_string(),
            result: None,
            new_session_id: None,
            error: Some("Something failed".to_string()),
            partial: None,
            usage: None,
            context_window: None,
            compacted: None,
        };

        app.finalize(output);
        assert!(app.messages.iter().any(|m| m.content.contains("Something failed")));
    }

    #[test]
    fn test_on_agent_exit() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;
        app.update_streaming("partial".to_string());

        app.on_agent_exit(Some(0));
        assert_eq!(app.agent_state, AgentState::Idle);
        assert!(!app.messages[0].is_streaming);
    }

    #[test]
    fn test_on_agent_exit_error_code() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;
        app.on_agent_exit(Some(1));
        assert!(app.messages.iter().any(|m| m.content.contains("code 1")));
    }

    #[test]
    fn test_input_editing_ascii() {
        let mut app = make_app();
        app.insert_char('H');
        app.insert_char('i');
        assert_eq!(app.input_buffer, "Hi");
        assert_eq!(app.cursor_pos, 2);

        app.move_cursor_left();
        assert_eq!(app.cursor_pos, 1);

        app.insert_char('!');
        assert_eq!(app.input_buffer, "H!i");

        app.move_cursor_home();
        assert_eq!(app.cursor_pos, 0);

        app.move_cursor_end();
        assert_eq!(app.cursor_pos, 3);
    }

    #[test]
    fn test_input_editing_cjk() {
        let mut app = make_app();
        app.insert_char('こ');
        app.insert_char('ん');
        app.insert_char('に');
        app.insert_char('ち');
        app.insert_char('は');
        assert_eq!(app.input_buffer, "こんにちは");

        app.delete_char_before();
        assert_eq!(app.input_buffer, "こんにち");

        app.move_cursor_left();
        app.move_cursor_left();
        app.delete_char_after();
        assert_eq!(app.input_buffer, "こんち");
    }

    #[test]
    fn test_finalize_compacted() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;

        let output = ContainerOutput {
            status: "success".to_string(),
            result: None,
            new_session_id: Some("sess-456".to_string()),
            error: None,
            partial: None,
            usage: None,
            context_window: None,
            compacted: Some(true),
        };

        app.finalize(output);

        assert!(app.messages.iter().any(|m| m.content.contains("compacted")));
        assert_eq!(app.session_id.as_deref(), Some("sess-456"));
    }

    #[test]
    fn test_finalize_no_streaming_message() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;

        let output = ContainerOutput {
            status: "success".to_string(),
            result: Some("Brand new response".to_string()),
            new_session_id: None,
            error: None,
            partial: None,
            usage: None,
            context_window: None,
            compacted: None,
        };

        app.finalize(output);

        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].content, "Brand new response");
        assert!(!app.messages[0].is_streaming);
        assert_eq!(app.messages[0].role, MessageRole::Assistant);
    }

    #[test]
    fn test_finalize_with_internal_tags() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;

        let output = ContainerOutput {
            status: "success".to_string(),
            result: Some("Visible <internal>hidden</internal> text".to_string()),
            new_session_id: None,
            error: None,
            partial: None,
            usage: None,
            context_window: None,
            compacted: None,
        };

        app.finalize(output);
        assert_eq!(app.messages.last().unwrap().content, "Visible  text");
    }

    #[test]
    fn test_on_agent_exit_none_code() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;
        app.on_agent_exit(None);
        assert_eq!(app.agent_state, AgentState::Idle);
        // No error message for None exit code
        assert!(app.messages.is_empty());
    }

    #[test]
    fn test_on_agent_exit_success_code() {
        let mut app = make_app();
        app.agent_state = AgentState::Running;
        app.on_agent_exit(Some(0));
        assert_eq!(app.agent_state, AgentState::Idle);
        // No error message for exit code 0
        assert!(app.messages.is_empty());
    }

    #[test]
    fn test_delete_char_before_at_beginning() {
        let mut app = make_app();
        app.input_buffer = "abc".to_string();
        app.cursor_pos = 0;
        app.delete_char_before(); // Should be no-op
        assert_eq!(app.input_buffer, "abc");
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn test_delete_char_after_at_end() {
        let mut app = make_app();
        app.input_buffer = "abc".to_string();
        app.cursor_pos = 3;
        app.delete_char_after(); // Should be no-op
        assert_eq!(app.input_buffer, "abc");
        assert_eq!(app.cursor_pos, 3);
    }

    #[test]
    fn test_move_cursor_left_at_beginning() {
        let mut app = make_app();
        app.input_buffer = "abc".to_string();
        app.cursor_pos = 0;
        app.move_cursor_left(); // Should be no-op
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn test_move_cursor_right_at_end() {
        let mut app = make_app();
        app.input_buffer = "abc".to_string();
        app.cursor_pos = 3;
        app.move_cursor_right(); // Should be no-op
        assert_eq!(app.cursor_pos, 3);
    }

    #[test]
    fn test_clear_line() {
        let mut app = make_app();
        app.input_buffer = "some text".to_string();
        app.cursor_pos = 5;
        app.clear_line();
        assert_eq!(app.input_buffer, "");
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn test_add_system_message_auto_scroll() {
        let mut app = make_app();
        app.auto_scroll = true;
        app.scroll_offset = 5;
        app.add_system_message("test");
        // auto_scroll resets scroll_offset to 0
        assert_eq!(app.scroll_offset, 0);
    }

    #[test]
    fn test_update_streaming_auto_scroll() {
        let mut app = make_app();
        app.auto_scroll = false;
        app.scroll_offset = 3;
        app.update_streaming("text".to_string());
        // Not auto-scrolling, so scroll_offset stays
        assert_eq!(app.scroll_offset, 3);
    }

    #[test]
    fn test_agent_state_display() {
        assert_eq!(AgentState::Idle.to_string(), "Idle");
        assert_eq!(AgentState::Running.to_string(), "Running");
        assert_eq!(AgentState::WaitingIpc.to_string(), "WaitingIpc");
    }

    #[test]
    fn test_scroll() {
        let mut app = make_app();
        assert!(app.auto_scroll);

        app.scroll_up(5);
        assert_eq!(app.scroll_offset, 5);
        assert!(!app.auto_scroll);

        app.scroll_down(3);
        assert_eq!(app.scroll_offset, 2);

        app.scroll_to_bottom();
        assert_eq!(app.scroll_offset, 0);
        assert!(app.auto_scroll);
    }

    // --- Session resume tests ---

    fn create_test_db_with_session(
        group_folder: &str,
        session_id: Option<&str>,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("messages.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                group_folder TEXT PRIMARY KEY,
                session_id TEXT NOT NULL
            );",
        )
        .unwrap();
        if let Some(sid) = session_id {
            conn.execute(
                "INSERT INTO sessions (group_folder, session_id) VALUES (?1, ?2)",
                [group_folder, sid],
            )
            .unwrap();
        }
        (dir, db_path)
    }

    fn make_app_with_db(db_path: std::path::PathBuf, group_folder: &str) -> AppState {
        let (tx, _rx) = mpsc::unbounded_channel();
        let config = NanoClawConfig {
            project_root: std::path::PathBuf::from("/tmp"),
            group_folder: group_folder.to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: std::path::PathBuf::from("/tmp"),
            group_dir: std::path::PathBuf::from("/tmp"),
            global_dir: std::path::PathBuf::from("/tmp"),
            extra_dir: std::path::PathBuf::from("/tmp"),
            claude_home: std::path::PathBuf::from("/tmp"),
            agent_runner_entry: std::path::PathBuf::from("/tmp"),
            db_path,
            env_vars: std::collections::HashMap::new(),
            model_aliases: std::collections::HashMap::new(),
        };
        AppState::new(config, tx)
    }

    #[test]
    fn test_session_resume_on_startup() {
        let (_dir, db_path) =
            create_test_db_with_session("test_group", Some("sess-resume-123"));
        let app = make_app_with_db(db_path, "test_group");
        assert_eq!(app.session_id.as_deref(), Some("sess-resume-123"));
    }

    #[test]
    fn test_no_session_on_startup() {
        let (_dir, db_path) = create_test_db_with_session("test_group", None);
        let app = make_app_with_db(db_path, "test_group");
        assert!(app.session_id.is_none());
    }

    // --- Suggestion tests ---

    #[test]
    fn test_suggestion_on_slash() {
        let mut app = make_app();
        app.insert_char('/');
        assert!(app.suggestion.is_some());
        let s = app.suggestion.as_ref().unwrap();
        assert_eq!(s.items.len(), 9);
        assert_eq!(s.selected, 0);
    }

    #[test]
    fn test_suggestion_filter() {
        let mut app = make_app();
        app.insert_char('/');
        app.insert_char('m');
        app.insert_char('o');
        let s = app.suggestion.as_ref().unwrap();
        assert_eq!(s.items.len(), 1);
        assert_eq!(s.items[0].0, "/model");
    }

    #[test]
    fn test_suggestion_no_match() {
        let mut app = make_app();
        app.insert_char('/');
        app.insert_char('x');
        assert!(app.suggestion.is_none());
    }

    #[test]
    fn test_suggestion_dismiss_on_backspace_to_empty() {
        let mut app = make_app();
        app.insert_char('/');
        assert!(app.suggestion.is_some());
        app.delete_char_before();
        assert!(app.suggestion.is_none());
    }

    #[test]
    fn test_suggestion_not_triggered_mid_text() {
        let mut app = make_app();
        app.insert_char('h');
        app.insert_char('i');
        app.insert_char('/');
        assert!(app.suggestion.is_none());
    }

    #[test]
    fn test_suggestion_accept() {
        let mut app = make_app();
        app.insert_char('/');
        app.insert_char('m');
        app.insert_char('o');
        app.suggestion_accept();
        assert_eq!(app.input_buffer, "/model");
        assert!(app.suggestion.is_none());
        // Verify the message was NOT submitted
        assert!(app.messages.is_empty());
    }

    #[test]
    fn test_suggestion_navigation() {
        let mut app = make_app();
        app.insert_char('/');
        assert_eq!(app.suggestion.as_ref().unwrap().selected, 0);

        app.suggestion_down();
        assert_eq!(app.suggestion.as_ref().unwrap().selected, 1);

        app.suggestion_up();
        assert_eq!(app.suggestion.as_ref().unwrap().selected, 0);

        // Can't go below 0
        app.suggestion_up();
        assert_eq!(app.suggestion.as_ref().unwrap().selected, 0);
    }

    #[test]
    fn test_suggestion_dismiss() {
        let mut app = make_app();
        app.insert_char('/');
        assert!(app.has_suggestions());
        app.suggestion_dismiss();
        assert!(!app.has_suggestions());
    }

    #[test]
    fn test_suggestion_disappears_with_space() {
        let mut app = make_app();
        for c in "/model".chars() {
            app.insert_char(c);
        }
        assert!(app.suggestion.is_some());
        app.insert_char(' ');
        assert!(app.suggestion.is_none());
    }

    #[test]
    fn test_suggestion_clear_line_dismisses() {
        let mut app = make_app();
        app.insert_char('/');
        assert!(app.has_suggestions());
        app.clear_line();
        assert!(!app.has_suggestions());
    }
}
