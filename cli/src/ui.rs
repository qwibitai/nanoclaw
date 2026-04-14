use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::{AgentState, AppState, ChatMessage, MessageRole, SuggestionState};

/// Render the entire TUI.
pub fn render(frame: &mut Frame, app: &AppState) {
    // Dynamic input area height for multi-line input
    let input_lines = (app.input_buffer.matches('\n').count() as u16 + 1).min(5);
    let input_height = input_lines + 2; // content lines + top/bottom border

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),           // Status bar
            Constraint::Min(3),             // Chat area
            Constraint::Length(input_height), // Input area
            Constraint::Length(1),           // Footer
        ])
        .split(frame.area());

    render_status_bar(frame, app, chunks[0]);
    render_chat_area(frame, app, chunks[1]);
    render_input_area(frame, app, chunks[2]);
    render_footer(frame, app, chunks[3]);

    // Render suggestion popup above input area
    if let Some(ref suggestion) = app.suggestion {
        render_suggestion_popup(frame, suggestion, chunks[2]);
    }

    // Set cursor position in input area (multi-line aware)
    let input_area = chunks[2];
    let text_before_cursor = &app.input_buffer[..app.cursor_pos];
    let cursor_line = text_before_cursor.matches('\n').count() as u16;
    let last_newline = text_before_cursor.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let cursor_display_x = display_width(&app.input_buffer[last_newline..app.cursor_pos]);
    let cursor_x = input_area.x + 1 + (cursor_display_x as u16).min(input_area.width.saturating_sub(3));
    let cursor_y = input_area.y + 1 + cursor_line;
    frame.set_cursor_position((cursor_x, cursor_y));
}

/// Status bar at the top.
fn render_status_bar(frame: &mut Frame, app: &AppState, area: Rect) {
    let model_name = short_model_name(app.config.effective_model());
    let title = format!(
        " NanoClaw TUI — {} ({}) ",
        app.config.group_folder, model_name
    );
    let bar = Paragraph::new(Line::from(vec![
        Span::styled(title, Style::default().fg(Color::Black).bg(Color::Cyan)),
    ]))
    .style(Style::default().bg(Color::Cyan).fg(Color::Black));
    frame.render_widget(bar, area);
}

/// Main chat area with message history.
fn render_chat_area(frame: &mut Frame, app: &AppState, area: Rect) {
    let chat_width = area.width.saturating_sub(2) as usize;
    if chat_width == 0 {
        return;
    }

    // Build all lines from messages
    let mut all_lines: Vec<Line> = Vec::new();
    for msg in &app.messages {
        let msg_lines = render_message(msg, chat_width);
        all_lines.extend(msg_lines);
        all_lines.push(Line::from("")); // blank line between messages
    }

    // Show spinner for running agent
    if app.agent_state == AgentState::Running
        && app.messages.last().map_or(true, |m| !m.is_streaming)
    {
        all_lines.push(Line::from(Span::styled(
            "  Thinking...",
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        )));
    }

    let visible_height = area.height.saturating_sub(2) as usize;
    let total_lines = all_lines.len();

    // Calculate scroll: scroll_offset is from the bottom
    let skip = if app.scroll_offset == 0 {
        total_lines.saturating_sub(visible_height)
    } else {
        total_lines
            .saturating_sub(visible_height)
            .saturating_sub(app.scroll_offset)
    };

    let visible_lines: Vec<Line> = all_lines
        .into_iter()
        .skip(skip)
        .take(visible_height)
        .collect();

    let chat = Paragraph::new(visible_lines)
        .block(Block::default().borders(Borders::NONE))
        .wrap(Wrap { trim: false });

    frame.render_widget(chat, area);
}

/// Render a single message into lines.
fn render_message(msg: &ChatMessage, width: usize) -> Vec<Line<'static>> {
    match msg.role {
        MessageRole::User => {
            let content = if msg.is_history {
                msg.content.clone()
            } else {
                format!("> {}", msg.content)
            };
            wrap_text_styled(
                &content,
                width,
                Style::default().fg(Color::Green),
            )
        }
        MessageRole::Assistant => {
            let content = if msg.is_streaming {
                format!("{}█", msg.content)
            } else {
                msg.content.clone()
            };
            wrap_text_styled(&content, width, Style::default())
        }
        MessageRole::System => {
            let content = format!("[{}]", msg.content);
            wrap_text_styled(&content, width, Style::default())
        }
        MessageRole::Splitter => {
            let sep = "─".repeat(width.min(60));
            vec![Line::from(Span::styled(
                sep,
                Style::default().fg(Color::DarkGray),
            ))]
        }
    }
}

/// Wrap text respecting CJK double-width characters.
fn wrap_text_styled(text: &str, width: usize, style: Style) -> Vec<Line<'static>> {
    if width == 0 {
        return vec![];
    }

    let mut lines = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            lines.push(Line::from(Span::styled(String::new(), style)));
            continue;
        }

        let wrapped = wrap_line_cjk(raw_line, width);
        for w in wrapped {
            lines.push(Line::from(Span::styled(w, style)));
        }
    }
    lines
}

/// Wrap a single line respecting CJK character widths.
fn wrap_line_cjk(line: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![];
    }

    let mut result = Vec::new();
    let mut current = String::new();
    let mut current_width: usize = 0;

    for ch in line.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if current_width + ch_width > max_width && !current.is_empty() {
            result.push(current);
            current = String::new();
            current_width = 0;
        }
        current.push(ch);
        current_width += ch_width;
    }

    if !current.is_empty() {
        result.push(current);
    }

    if result.is_empty() {
        result.push(String::new());
    }

    result
}

/// Input area at the bottom.
fn render_input_area(frame: &mut Frame, app: &AppState, area: Rect) {
    let input_text = &app.input_buffer;
    let input = Paragraph::new(input_text.as_str())
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(Span::styled(
                    " > ",
                    Style::default().fg(Color::Green),
                )),
        )
        .style(Style::default().fg(Color::White));
    frame.render_widget(input, area);
}

/// Footer with agent state and usage info.
fn render_footer(frame: &mut Frame, app: &AppState, area: Rect) {
    let mut parts = Vec::new();

    // Agent state
    let state_style = match app.agent_state {
        AgentState::Idle => Style::default().fg(Color::DarkGray),
        AgentState::Running => Style::default().fg(Color::Yellow),
        AgentState::WaitingIpc => Style::default().fg(Color::Green),
    };
    parts.push(Span::styled(
        format!(" [{}]", app.agent_state),
        state_style,
    ));

    // Usage
    if let Some(ref u) = app.last_usage {
        parts.push(Span::styled(
            format!(
                " {}in/{}out",
                format_tokens(u.input_tokens),
                format_tokens(u.output_tokens),
            ),
            Style::default().fg(Color::DarkGray),
        ));
    }

    // Session
    if let Some(ref sid) = app.session_id {
        let short = if sid.len() > 8 { &sid[..8] } else { sid };
        parts.push(Span::styled(
            format!("  session:{short}"),
            Style::default().fg(Color::DarkGray),
        ));
    }

    // Scroll indicator
    if app.scroll_offset > 0 {
        parts.push(Span::styled(
            format!("  [scroll:+{}]", app.scroll_offset),
            Style::default().fg(Color::Yellow),
        ));
    }

    let footer = Paragraph::new(Line::from(parts));
    frame.render_widget(footer, area);
}

/// Render the slash command suggestion popup above the input area.
fn render_suggestion_popup(frame: &mut Frame, suggestion: &SuggestionState, input_area: Rect) {
    let item_count = suggestion.items.len() as u16;
    let popup_height = item_count.min(9) + 2; // items + borders
    let popup_width = input_area.width.min(40);

    let popup_area = Rect {
        x: input_area.x,
        y: input_area.y.saturating_sub(popup_height),
        width: popup_width,
        height: popup_height,
    };

    let lines: Vec<Line> = suggestion
        .items
        .iter()
        .enumerate()
        .map(|(i, (name, desc))| {
            let style = if i == suggestion.selected {
                Style::default().fg(Color::Black).bg(Color::Cyan)
            } else {
                Style::default().fg(Color::White)
            };
            Line::from(Span::styled(
                format!(" {:<10} {}", name, desc),
                style,
            ))
        })
        .collect();

    let popup = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray)),
    );

    frame.render_widget(Clear, popup_area);
    frame.render_widget(popup, popup_area);
}

/// Shorten model name for display.
fn short_model_name(model: &str) -> &str {
    // Strip "claude-" prefix and date suffix for compact display
    let name = model.strip_prefix("claude-").unwrap_or(model);
    if let Some(pos) = name.rfind('-') {
        // Check if suffix looks like a date (YYYYMMDD)
        let suffix = &name[pos + 1..];
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return &name[..pos];
        }
    }
    name
}

/// Calculate display width of a string (CJK-aware).
fn display_width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// Format token count.
fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_model_name() {
        assert_eq!(short_model_name("claude-sonnet-4-20250514"), "sonnet-4");
        assert_eq!(short_model_name("claude-opus-4-20250514"), "opus-4");
        assert_eq!(short_model_name("claude-haiku-3-5-20241022"), "haiku-3-5");
        assert_eq!(short_model_name("custom-model"), "custom-model");
    }

    #[test]
    fn test_display_width_ascii() {
        assert_eq!(display_width("Hello"), 5);
        assert_eq!(display_width(""), 0);
    }

    #[test]
    fn test_display_width_cjk() {
        assert_eq!(display_width("日本語"), 6); // Each CJK char is 2 wide
        assert_eq!(display_width("こんにちは"), 10);
    }

    #[test]
    fn test_display_width_mixed() {
        assert_eq!(display_width("Hello世界"), 9); // 5 + 2*2
        assert_eq!(display_width("abc日本語xyz"), 12); // 3 + 6 + 3
    }

    #[test]
    fn test_wrap_line_cjk_ascii() {
        let result = wrap_line_cjk("Hello, world!", 10);
        assert_eq!(result, vec!["Hello, wor", "ld!"]);
    }

    #[test]
    fn test_wrap_line_cjk_japanese() {
        let result = wrap_line_cjk("日本語テスト", 8); // Each char is 2 wide -> 4 per line
        assert_eq!(result, vec!["日本語テ", "スト"]);
    }

    #[test]
    fn test_wrap_line_cjk_mixed() {
        let result = wrap_line_cjk("Hi日本", 6);
        assert_eq!(result, vec!["Hi日本"]); // 2 + 4 = 6, fits exactly
    }

    #[test]
    fn test_wrap_line_cjk_break_at_boundary() {
        let result = wrap_line_cjk("AB日C", 4);
        // AB = 2 width, 日 = 2 width -> "AB日" = 4, fits
        assert_eq!(result, vec!["AB日", "C"]);
    }

    #[test]
    fn test_wrap_line_cjk_single_wide_char_exceeds() {
        let result = wrap_line_cjk("A日", 2);
        // A=1, 日=2 -> A fits at 1, 日 doesn't fit -> wrap
        assert_eq!(result, vec!["A", "日"]);
    }

    #[test]
    fn test_wrap_line_empty() {
        let result = wrap_line_cjk("", 10);
        assert_eq!(result, vec![""]);
    }

    #[test]
    fn test_wrap_line_korean() {
        let result = wrap_line_cjk("한국어", 4);
        assert_eq!(result, vec!["한국", "어"]);
    }

    #[test]
    fn test_wrap_text_multiline() {
        let lines = wrap_text_styled("Line 1\nLine 2", 80, Style::default());
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_format_tokens() {
        assert_eq!(format_tokens(500), "500");
        assert_eq!(format_tokens(1500), "1.5k");
        assert_eq!(format_tokens(2_500_000), "2.5M");
    }

    #[test]
    fn test_format_tokens_zero() {
        assert_eq!(format_tokens(0), "0");
    }

    #[test]
    fn test_format_tokens_boundaries() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1000), "1.0k");
        assert_eq!(format_tokens(999_999), "1000.0k");
        assert_eq!(format_tokens(1_000_000), "1.0M");
    }

    #[test]
    fn test_short_model_name_no_date_suffix() {
        assert_eq!(short_model_name("claude-opus-4"), "opus-4");
    }

    #[test]
    fn test_short_model_name_no_prefix() {
        assert_eq!(short_model_name("opus-4-20250514"), "opus-4");
    }

    #[test]
    fn test_short_model_name_plain() {
        assert_eq!(short_model_name("gpt-4"), "gpt-4");
    }

    #[test]
    fn test_wrap_line_cjk_zero_width() {
        let result = wrap_line_cjk("Hello", 0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_wrap_text_styled_zero_width() {
        let result = wrap_text_styled("Hello", 0, Style::default());
        assert!(result.is_empty());
    }

    #[test]
    fn test_wrap_text_styled_empty_lines() {
        let result = wrap_text_styled("Line1\n\nLine3", 80, Style::default());
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_wrap_line_cjk_exact_fit() {
        let result = wrap_line_cjk("ABCDE", 5);
        assert_eq!(result, vec!["ABCDE"]);
    }

    #[test]
    fn test_display_width_emoji() {
        // Emoji width varies by implementation; just ensure no panic
        let w = display_width("👋");
        assert!(w >= 1);
    }

    #[test]
    fn test_wrap_line_chinese() {
        let result = wrap_line_cjk("中文测试", 4);
        assert_eq!(result, vec!["中文", "测试"]);
    }

    #[test]
    fn test_wrap_mixed_ascii_cjk_word() {
        // "ABC日DEF" = 3+2+3 = 8, wrap at 6
        // ABC日D = 3+2+1 = 6 fits exactly, EF wraps
        let result = wrap_line_cjk("ABC日DEF", 6);
        assert_eq!(result, vec!["ABC日D", "EF"]);
    }
}
