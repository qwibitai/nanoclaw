# Google Home Integration Design

**Date:** 2026-02-22
**Status:** Approved

## Goal

Let NanoClaw agents control smart home devices via Google Assistant and manage Google Home automations using the scripted automation YAML syntax.

## Architecture

### Components

1. **Python daemon** (`scripts/google-assistant-daemon.py`) — Persistent process in `scripts/venv/`. Handles OAuth session and gRPC communication with Google Assistant. Stdin/stdout line-delimited JSON protocol (same pattern as voice recognition daemon).

2. **TypeScript manager** (`src/google-assistant.ts`) — Spawns and manages daemon lifecycle, provides typed API for the IPC handler.

3. **Container skill** (`container/skills/google-home/SKILL.md`) — Agent-facing interface. Agents call `google-home:command "..."` for device control and `google-home:automation generate` for automation scripting. Bash wrapper communicates via IPC.

4. **IPC task type** — New `google_assistant_command` task type in `src/ipc.ts`. Agent writes command JSON, host processes it via daemon, returns result via IPC messages.

### Data Flow

```
Agent container → IPC task file → Host IPC watcher →
TypeScript manager → Python daemon → Google Assistant gRPC →
Response → IPC message file → Agent reads response
```

For automations:
```
Agent generates YAML → Returns to user via chat
  OR
Agent generates YAML → agent-browser → Google Home web UI
```

## Python Daemon

**File:** `scripts/google-assistant-daemon.py`

**Dependencies** (in existing `scripts/venv/`):
- `google-assistant-grpc` — Official gRPC bindings
- `google-auth-oauthlib` — OAuth 2.0 credential management
- `google-auth` — Token refresh

**Protocol:**
- Startup: loads credentials, establishes gRPC channel, prints `{"status": "ready"}`
- Commands via stdin (line-delimited JSON):
  - `{"type": "command", "text": "turn on the living room lights"}`
  - `{"type": "health"}`
- Responses on stdout:
  - `{"status": "ok", "text": "OK, turning on the living room lights", "raw_html": "..."}`
  - `{"status": "error", "error": "..."}`

**OAuth:**
- Credentials stored at `data/google-assistant/credentials.json`
- Auto-refreshes expired tokens
- Desktop app OAuth type (required since Oct 2025 for smart home commands)

**Device registration:**
- Registers device model + instance on first run (Google requirement)
- Config stored at `data/google-assistant/device_config.json`

**Conversation state:**
- Maintains `conversation_state` between requests for multi-turn conversations

## Container Skill

**File:** `container/skills/google-home/SKILL.md`

```yaml
---
name: google-home
description: Control Google Home smart home devices and manage automations
allowed-tools: Bash(google-home:*)
---
```

**Frontmatter includes:**
- Device list with names and types (placeholder, user fills in)
- Google Home automation schema reference (starters, conditions, actions)
- Example automations

**Commands:**
- `google-home:command "..."` — Natural language smart home command
- `google-home:command "what temperature is the thermostat?"` — Query with response
- `google-home:automation generate` — Generate YAML automation from description
- `google-home:automation push` — Push YAML to Google Home via agent-browser
- `google-home:status` — Health check

**IPC mechanism:** Bash wrapper writes JSON task to `/workspace/ipc/tasks/`, host processes it, writes response to `/workspace/ipc/messages/`, wrapper polls for response.

## Automation Management

**YAML generation:** Skill markdown includes complete Google Home automation schema so the agent can generate valid YAML:
- Starters: time.schedule, device.state.*, device.event.*, home.state.HomePresence, assistant.event.OkGoogle
- Conditions: and, or, not, time.between, device states
- Actions: OnOff, BrightnessAbsolute, ColorAbsolute, ThermostatSetMode, OpenClose, LockUnlock, Notification, time.delay, etc.
- Data types: bool, number, string, date (MM-DD), time (HH:MM, sunrise/sunset+offset), temperature (20.5C/90F), duration (30min), entity ("device name - room name")

**Browser push:** Optional, uses agent-browser to navigate to home.google.com script editor. Documented as best-effort (web UI can change).

## Setup Flow

1. Create Google Cloud project, enable Google Assistant API
2. Create OAuth 2.0 Desktop app credentials, download `client_secret.json`
3. Run `scripts/google-assistant-setup.py`:
   - Takes client_secret.json path as argument
   - Opens browser for OAuth consent (scope: `assistant-sdk-prototype`)
   - Registers device model + instance with Google
   - Saves credentials to `data/google-assistant/`
4. Add device names to skill frontmatter

## Security

- OAuth credentials stored in `data/` (gitignored)
- No credentials mounted into containers — all communication via IPC
- Host daemon is the only process with Google API access

## Key Decisions

- **Python over Node.js:** Battle-tested `google-assistant-grpc` library; existing venv infrastructure
- **Daemon over per-call:** Persistent OAuth session, conversation state, faster responses
- **IPC over direct access:** Keeps credentials on host, containers never see OAuth tokens
- **YAML generation over API:** Google Home Automation API is Android/iOS only; no server-side REST API exists
- **Desktop app OAuth:** Required since Oct 2025 change; web app credentials return empty responses for smart home

## References

- [Google Assistant SDK Overview](https://developers.google.com/assistant/sdk/overview)
- [gRPC Integration Guide](https://developers.google.com/assistant/sdk/guides/service/integrate)
- [Google Home Automation Schema](https://developers.home.google.com/automations/schema/basics)
- [Automation Examples](https://developers.home.google.com/automations/example-scripts)
- [Supported Starters/Conditions/Actions](https://developers.home.google.com/automations/starters-conditions-and-actions)
- [Home Assistant SDK Custom (workaround reference)](https://github.com/tronikos/google_assistant_sdk_custom)
