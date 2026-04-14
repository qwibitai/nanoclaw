# nanoclaw-cli

Local TUI chat interface for NanoClaw agents. Provides a Claude Code-like terminal experience for interacting with your NanoClaw agent directly from the command line.

## Prerequisites

- **Rust toolchain** (1.70+): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **NanoClaw** installed and built (`npm run build`)
- **Agent-runner** compiled: `container/agent-runner/dist/index.js` must exist

## Build & Install

```bash
cd cli
cargo build --release
install -m 755 target/release/nanoclaw-cli ~/.local/bin/
```

Or use `cargo install`:

```bash
cargo install --path cli
ln -sf ~/.cargo/bin/nanoclaw-cli ~/.local/bin/nanoclaw-cli
```

## Usage

```bash
# Default: connect to the main group
nanoclaw-cli

# Specify a group by name or folder
nanoclaw-cli -g telegram_main
nanoclaw-cli -g dev_group

# Point to a specific NanoClaw installation
nanoclaw-cli --nanoclaw-dir ~/src/nanoclaw

# Load last 20 messages from Telegram history on startup
nanoclaw-cli --history 20
```

### Options

| Flag | Description |
|------|-------------|
| `-g, --group <NAME>` | Group name or folder (default: main group) |
| `--nanoclaw-dir <PATH>` | NanoClaw installation directory |
| `--history <N>` | Load last N messages from database on startup |

The NanoClaw directory is resolved in order: `--nanoclaw-dir` flag > `NANOCLAW_DIR` env var > walk up from cwd > `~/nanoclaw`.

## Configuration

The TUI reads its configuration from the NanoClaw installation:

- **`.env`** — Auth credentials (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`), `ASSISTANT_NAME`, `DEFAULT_MODEL`, `TZ`
- **`~/.config/nanoclaw/model-aliases.json`** — Model alias mappings (e.g., `{"opus": "claude-opus-4-20250514"}`)
- **`store/messages.db`** — SQLite database for groups, sessions, tasks, message history

## Commands

| Command | Description |
|---------|-------------|
| `/model <name\|reset>` | Set the model for this group (supports aliases). `/model reset` clears the override. |
| `/effort <low\|medium\|high\|max\|reset>` | Set thinking effort level. `/effort reset` clears the override. |
| `/status` | Show agent state, model, effort, session, token usage, context window |
| `/clear` | Clear the current conversation session and start fresh |
| `/compact` | Compact the agent's context (requires active session) |
| `/tasks` | List scheduled tasks for this group |
| `/history [N]` | Load last N messages from the database (default: 20) |
| `/quit` or `/exit` | Exit the TUI |

## Key Bindings

| Key | Action |
|-----|--------|
| `Enter` | Send message (or follow-up to active agent) |
| `Ctrl+C` | Quit |
| `Esc` | Scroll to bottom / clear input |
| `Up/Down` | Scroll chat (or browse input history when input is empty) |
| `PageUp/PageDown` | Scroll chat by 10 lines |
| `Left/Right` | Move cursor |
| `Home/End` | Move cursor to start/end of line |
| `Backspace/Delete` | Delete character |
| `Ctrl+U` | Clear input line |

## Architecture

```
nanoclaw-cli
    |
    +-- Spawns: node container/agent-runner/dist/index.js
    |     (same agent-runner used by NanoClaw host-runner)
    |
    +-- stdin: ContainerInput JSON (prompt, session, model, etc.)
    +-- stdout: ---NANOCLAW_OUTPUT_START--- / ---NANOCLAW_OUTPUT_END--- markers
    |     - partial: true -> streaming text (updates TUI in real-time)
    |     - partial: false/omitted -> final result
    |
    +-- Follow-up messages: writes JSON to data/cli-ipc/{group}/input/
    |     (agent-runner polls every 500ms)
    |
    +-- Session end: writes _close sentinel to data/cli-ipc/{group}/input/_close
```

The TUI uses a separate IPC namespace (`data/cli-ipc/`) from the main NanoClaw orchestrator (`data/ipc/`). This prevents interference when both are running simultaneously.

## Limitations

- **Fully isolated from Telegram.** Messages in the TUI (both user and agent) exist only in the TUI and the agent's session context. They are not forwarded to Telegram.
- **Images** are displayed as `[#image filename]` — the TUI does not render images inline.
