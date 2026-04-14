mod agent;
mod app;
mod commands;
mod config;
mod db;
mod event;
mod session;
mod ui;

use std::io;
use std::path::PathBuf;

use clap::Parser;
use crossterm::event::{
    Event, EventStream, KeyCode, KeyEventKind, KeyModifiers,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use app::AppState;
use event::AppEvent;

/// NanoClaw TUI — Local chat interface for NanoClaw agents
#[derive(Parser)]
#[command(name = "nanoclaw-cli", version, about)]
struct Args {
    /// Group name or folder (default: main group)
    #[arg(short, long)]
    group: Option<String>,

    /// NanoClaw installation directory (or set NANOCLAW_DIR env var)
    #[arg(long)]
    nanoclaw_dir: Option<PathBuf>,

    /// Load last N messages from database on startup
    #[arg(long, default_value = "50")]
    history: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Resolve NanoClaw directory
    let project_root = config::find_nanoclaw_dir(args.nanoclaw_dir.as_deref())
        .map_err(|e| anyhow::anyhow!(e))?;

    // Open database and resolve group
    let db_path = project_root.join("store").join("messages.db");
    let conn = db::open_readonly(&db_path).map_err(|e| anyhow::anyhow!(e))?;

    let group = if let Some(ref query) = args.group {
        db::find_group(&conn, query).map_err(|e| anyhow::anyhow!(e))?
    } else {
        db::get_main_group(&conn).map_err(|e| anyhow::anyhow!(e))?
    };

    // Build config
    let nano_config = config::build_config(
        project_root,
        group.folder.clone(),
        group.jid.clone(),
        group.name.clone(),
        group.is_main,
        group.model.clone(),
        group.effort.clone(),
    );

    // Check agent-runner exists
    if !nano_config.agent_runner_entry.exists() {
        eprintln!(
            "Error: agent-runner not found at {}",
            nano_config.agent_runner_entry.display()
        );
        eprintln!("Run `npm run build` in the NanoClaw directory first.");
        std::process::exit(1);
    }

    // Set up event channel
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AppEvent>();

    // Set up terminal with panic hook for clean restore
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        original_hook(panic_info);
    }));

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    )?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Create app state
    let mut app = AppState::new(nano_config, event_tx.clone());

    // Load history if requested
    if args.history > 0 {
        let db_messages = db::get_messages(&conn, &group.jid, args.history);

        // Load assistant messages from session JSONL
        let session_messages = app
            .session_id
            .as_ref()
            .and_then(|sid| {
                session::find_session_file(
                    &app.config.project_root,
                    &app.config.group_folder,
                    sid,
                )
            })
            .map(|path| session::read_assistant_messages(&path, args.history))
            .unwrap_or_default();

        // Merge into a single chronological list
        struct Entry {
            timestamp: String,
            role: app::MessageRole,
            content: String,
        }

        let mut entries: Vec<Entry> = Vec::new();

        for m in &db_messages {
            let time = db::format_local_time(&m.timestamp);
            let content = format!("[{}] {}: {}", time, m.sender_name, m.content);
            entries.push(Entry {
                timestamp: m.timestamp.clone(),
                role: app::MessageRole::User,
                content,
            });
        }

        for m in &session_messages {
            let time = db::format_local_time(&m.timestamp);
            let content = format!("[{}] {}: {}", time, group.name, m.content);
            entries.push(Entry {
                timestamp: m.timestamp.clone(),
                role: app::MessageRole::Assistant,
                content,
            });
        }

        // Sort by timestamp (strip trailing Z for consistent comparison)
        entries.sort_by(|a, b| {
            let ta = a.timestamp.trim_end_matches('Z');
            let tb = b.timestamp.trim_end_matches('Z');
            ta.cmp(tb)
        });

        // Keep only the last N entries
        let start = entries.len().saturating_sub(args.history);
        for entry in &entries[start..] {
            app.add_history_message(entry.role.clone(), &entry.content);
        }

        if let Some(last) = db_messages.last() {
            app.last_db_message_ts = Some(last.timestamp.clone());
        }
        if !entries.is_empty() {
            app.add_splitter();
        }
    } else {
        // No history loaded — set watermark to now so polling starts from this point
        app.last_db_message_ts =
            Some(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string());
    }

    // Drop read-only connection
    drop(conn);

    // Spawn crossterm event reader (Press events only)
    let tx_keys = event_tx.clone();
    tokio::spawn(async move {
        let mut reader = EventStream::new();
        while let Some(Ok(event)) = reader.next().await {
            let app_event = match event {
                Event::Key(key) if key.kind == KeyEventKind::Press => AppEvent::Key(key),
                Event::Resize(w, h) => AppEvent::Resize(w, h),
                _ => continue,
            };
            if tx_keys.send(app_event).is_err() {
                break;
            }
        }
    });

    // Spawn tick timer
    let tx_tick = event_tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(100));
        loop {
            interval.tick().await;
            if tx_tick.send(AppEvent::Tick).is_err() {
                break;
            }
        }
    });

    // Spawn DB polling task (every 3 seconds)
    let tx_db = event_tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3));
        interval.tick().await; // skip first immediate tick
        loop {
            interval.tick().await;
            if tx_db.send(AppEvent::DbPoll).is_err() {
                break;
            }
        }
    });

    // Main event loop
    loop {
        terminal.draw(|f| ui::render(f, &app))?;

        match event_rx.recv().await {
            Some(AppEvent::Key(key)) => {
                // Suggestion popup takes priority for navigation keys
                if app.has_suggestions() {
                    match key.code {
                        KeyCode::Up => { app.suggestion_up(); continue; }
                        KeyCode::Down => { app.suggestion_down(); continue; }
                        KeyCode::Enter | KeyCode::Tab => { app.suggestion_accept(); continue; }
                        KeyCode::Esc => { app.suggestion_dismiss(); continue; }
                        _ => {} // fall through to normal handling
                    }
                }

                // Handle key events
                match (key.code, key.modifiers) {
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        app.should_quit = true;
                    }
                    (KeyCode::Enter, m) if m.contains(KeyModifiers::SHIFT) => {
                        app.insert_char('\n');
                    }
                    (KeyCode::Enter, _) => {
                        app.submit_message().await;
                    }
                    (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                        app.clear_line();
                    }
                    (KeyCode::Char(c), _) => {
                        app.insert_char(c);
                    }
                    (KeyCode::Backspace, _) => {
                        app.delete_char_before();
                    }
                    (KeyCode::Delete, _) => {
                        app.delete_char_after();
                    }
                    (KeyCode::Left, _) => {
                        app.move_cursor_left();
                    }
                    (KeyCode::Right, _) => {
                        app.move_cursor_right();
                    }
                    (KeyCode::Home, _) => {
                        app.move_cursor_home();
                    }
                    (KeyCode::End, _) => {
                        app.move_cursor_end();
                    }
                    (KeyCode::Up, _) => {
                        app.scroll_up(1);
                    }
                    (KeyCode::Down, _) => {
                        app.scroll_down(1);
                    }
                    (KeyCode::PageUp, _) => {
                        app.scroll_up(10);
                    }
                    (KeyCode::PageDown, _) => {
                        app.scroll_down(10);
                    }
                    (KeyCode::Esc, _) => {
                        if app.scroll_offset > 0 {
                            app.scroll_to_bottom();
                        } else {
                            app.clear_line();
                        }
                    }
                    _ => {}
                }
            }
            Some(AppEvent::AgentPartial(text)) => {
                app.update_streaming(text);
            }
            Some(AppEvent::AgentFinal(output)) => {
                app.finalize(output);
            }
            Some(AppEvent::AgentExited(code)) => {
                app.on_agent_exit(code);
            }
            Some(AppEvent::AgentError(err)) => {
                app.add_system_message(&format!("Agent error: {err}"));
            }
            Some(AppEvent::DbPoll) => {
                if let Some(ref ts) = app.last_db_message_ts {
                    if let Ok(poll_conn) = db::open_readonly(&app.config.db_path) {
                        let new_msgs =
                            db::get_messages_since(&poll_conn, &app.config.group_jid, ts);
                        app.on_new_db_messages(new_msgs);
                    }
                }
            }
            Some(AppEvent::Resize(_, _)) | Some(AppEvent::Tick) => {}
            None => break,
        }

        if app.should_quit {
            break;
        }
    }

    // Graceful shutdown
    app.shutdown().await;

    // Restore terminal
    execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags)?;
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;

    Ok(())
}
