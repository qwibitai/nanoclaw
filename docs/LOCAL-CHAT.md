# Local Chat

An embedded web chat interface for NanoClaw. Runs as an in-process HTTP + WebSocket server with a progressive web app (PWA) frontend.

## Overview

Local Chat adds a browser-based chat to NanoClaw, accessible at `http://localhost:3100`. It gives you a self-hosted alternative to messaging channels like WhatsApp or Discord — no external services, no accounts, no API keys.

Features:
- Real-time chat with NanoClaw agents via WebSocket
- Multiple rooms with bot assignment
- Bot management (create, configure, delete)
- Dashboard with system health and activity feed
- File upload with drag-drop, paste, and captions
- Typing indicators and live agent status ("Reading file", "Running command")
- Markdown rendering with syntax highlighting in agent responses
- Dark/light/system themes, configurable font size
- Mobile-responsive with full-screen chat view
- Bearer token + Tailscale authentication for remote access

## Architecture

```
Browser (PWA)  <--WebSocket-->  chat-server.ts  <--channel adapter-->  NanoClaw core
                                     |
                               chat.sqlite (rooms, messages, tokens, workflows)
                                     |
                               groups/{folder}/uploads/ (file storage)
```

The chat server runs inside the main NanoClaw process (no separate service). It shares the same Node.js event loop and SQLite connection. The `LocalChatChannel` adapter bridges WebSocket messages into NanoClaw's channel system, so agents process local chat messages identically to WhatsApp or Discord messages.

### Key files

| File | Purpose |
|------|---------|
| `src/chat-server.ts` | HTTP server, WebSocket handler, REST API, auth, file upload |
| `src/chat-db.ts` | SQLite persistence (rooms, messages, tokens, workflows) |
| `src/channels/local-chat.ts` | Channel adapter (bridges WS messages to NanoClaw core) |
| `chat-pwa/index.html` | PWA shell |
| `chat-pwa/app.js` | Frontend logic (ES module) |
| `chat-pwa/style.css` | Theming and layout |
| `chat-pwa/sw.js` | Service worker for offline caching |

### Data flow

1. User sends a message in the PWA via WebSocket
2. `chat-server.ts` stores it in `chat.sqlite` and broadcasts to other clients
3. `onNewMessageCallback` fires, passing the message to `LocalChatChannel`
4. The channel adapter calls `opts.onMessage()`, entering NanoClaw's standard message pipeline
5. The message is formatted and sent to the agent container
6. The agent's response comes back via `channel.sendMessage()`, which stores and broadcasts it

## Setup

See the [/add-local-chat skill](./.claude/skills/add-local-chat/SKILL.md) for step-by-step setup instructions. The short version:

```bash
# Enable in environment
export CHAT_SERVER_ENABLED=true

# Build and restart
npm run build
systemctl --user restart nanoclaw  # or launchctl on macOS
```

The server starts on port 3100 by default, bound to localhost.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_SERVER_ENABLED` | `false` | Enable the chat server |
| `CHAT_SERVER_PORT` | `3100` | HTTP/WebSocket port |
| `CHAT_SERVER_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for network access) |
| `CHAT_SERVER_TOKEN` | (none) | Bearer token for remote authentication |

## Authentication

Three auth methods, evaluated in order:

1. **Localhost** — connections from `127.0.0.1` or `::1` always pass. No token needed.
2. **Tailscale** — if the connecting IP is a Tailscale peer, identity is resolved via `tailscale whois`. No token needed.
3. **Bearer token** — remote connections can authenticate with `Authorization: Bearer <token>` header (HTTP) or `?token=<token>` query parameter (WebSocket).

If `CHAT_SERVER_HOST` is set to `0.0.0.0`, configure at least one of Tailscale or a bearer token. Without either, the server logs a warning and allows unauthenticated remote connections.

The PWA shows a login screen when accessing from a non-localhost address without Tailscale. The token is stored in `localStorage`.

## API Reference

All endpoints require authentication (except health and OPTIONS).

### Rooms

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/rooms` | List all rooms |
| `POST` | `/api/rooms` | Create a room (`{ id, name }`) |
| `GET` | `/api/rooms/:id/messages` | Message history (last 100) |
| `POST` | `/api/rooms/:id/upload` | Upload a file (multipart, optional `caption` field) |

### Bots

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots` | List all registered bots/groups |
| `POST` | `/api/bots` | Create a bot (`{ jid, name, folder, trigger }`) |
| `PUT` | `/api/bots/:jid` | Update a bot (`{ name, trigger, requiresTrigger }`) |
| `DELETE` | `/api/bots/:jid` | Delete a bot (also deletes its chat room) |
| `GET` | `/api/bots/:jid/instructions` | Get CLAUDE.md content |
| `PUT` | `/api/bots/:jid/instructions` | Update CLAUDE.md (`{ content }`) |
| `POST` | `/api/bots/create-from-chat` | Create a bot via the main agent (`{ description }`) |

### Workflows

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workflows` | List all workflows |
| `POST` | `/api/workflows` | Create a workflow (`{ name, steps }`) |
| `GET` | `/api/workflows/:id` | Get a workflow |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete a workflow |

### Files

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files/:folder/:filename` | Serve an uploaded file |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (`{ ok, uptime }`) |
| `GET` | `/api/auth/check` | Verify authentication |
| `GET` | `/api/agents` | List agent tokens |
| `POST` | `/api/agents` | Create an agent token |

### WebSocket

Connect to `/ws` (or `/ws?token=<token>` for authenticated connections).

Message types (client to server):

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `{ token? }` | Authenticate (token for agents, omit for users) |
| `join` | `{ room_id }` | Join a room |
| `message` | `{ content, client_id? }` | Send a message |
| `typing` | `{ is_typing }` | Typing indicator |

Message types (server to client):

| Type | Description |
|------|-------------|
| `system` | System message (connected, joined, left) |
| `rooms` | Room list |
| `history` | Message history for joined room |
| `message` | New message |
| `members` | Updated member list |
| `typing` | Typing indicator from another user/agent |
| `status` | Agent status update (tool use, thinking) |
| `unread` | Unread notification for another room |
| `error` | Error message |

## File Upload

Files are stored in `groups/{folder}/uploads/` — inside the group's folder, which is already mounted into agent containers. Agents can access uploaded files at `/workspace/group/uploads/`.

Upload methods:
- **File picker** (paperclip button)
- **Drag and drop** onto the messages area
- **Paste** from clipboard (Ctrl+V)

Files are staged with a preview bar before sending. Type a caption in the input field to attach instructions (e.g., "review this code"). The file and caption are sent as a single message.

Limits: 50MB per file. Common MIME types served with correct headers. Files cached with immutable headers.

## Agent Status

When an agent is processing a message, the PWA shows a thinking bubble with live status updates:

- "Claw -- Thinking" (agent is composing)
- "Claw -- Reading file" (agent uses Read tool)
- "Claw -- Running command" (agent uses Bash)
- "Claw -- Searching code" (agent uses Grep)

This works by emitting status markers from the agent-runner inside the container, parsed by the container-runner on the host, and forwarded via the `sendStatus` channel method to the WebSocket.

## Theming

The PWA supports three themes: dark (default), light, and system (follows OS preference). Configurable in Settings (gear icon in sidebar).

All colors use CSS custom properties (`--bg`, `--surface`, `--accent`, etc.) defined in `:root` and `[data-theme="light"]`. Adding a new theme means defining a new set of variable values.

Font size (small/medium/large) scales the entire UI via `font-size` on `#app`, with key elements using `em` units.

## Mobile

At viewports under 600px:
- Sidebar shows full-width with room list
- Entering a room hides the sidebar, chat takes full screen
- Back button (chevron) in the chat header returns to the sidebar
- Dashboard also takes full screen with its own back button
- Send button becomes an arrow icon
- Smaller default font sizes
