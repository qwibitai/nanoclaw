# Google Home Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let NanoClaw agents control smart home devices via Google Assistant gRPC and generate/push Google Home automation YAML scripts.

**Architecture:** Python daemon (`scripts/google-assistant-daemon.py`) communicates with Google Assistant via gRPC text queries. TypeScript manager (`src/google-assistant.ts`) spawns and manages the daemon. Container agents access it via IPC: Bash wrapper writes request to `/workspace/ipc/tasks/`, host processes it, writes response to `/workspace/ipc/responses/`, wrapper polls and returns the result.

**Tech Stack:** Python (google-assistant-grpc, google-auth-oauthlib), TypeScript (child_process, readline), IPC files, container skill Bash wrapper.

---

### Task 1: Install Python dependencies

**Files:**
- Modify: `scripts/requirements.txt` (or install directly into venv)

**Step 1: Install Google Assistant gRPC packages into existing venv**

```bash
scripts/venv/bin/pip install google-assistant-grpc google-auth-oauthlib google-auth
```

**Step 2: Verify installation**

```bash
scripts/venv/bin/python3 -c "import google.assistant.embedded.v1alpha2; print('OK')"
scripts/venv/bin/python3 -c "import google_auth_oauthlib; print('OK')"
```

Expected: Both print "OK"

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: install google-assistant-grpc dependencies in venv"
```

---

### Task 2: Create the Google Assistant setup script

**Files:**
- Create: `scripts/google-assistant-setup.py`

**Step 1: Write the setup script**

This interactive script handles first-time OAuth flow and device registration. The user runs it once with their `client_secret.json` from Google Cloud Console.

```python
#!/usr/bin/env python3
"""
Google Assistant OAuth setup.

Usage:
  python3 scripts/google-assistant-setup.py /path/to/client_secret.json

Creates credentials and device config in data/google-assistant/.
"""

import sys
import os
import json

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
import google.auth.transport.grpc as google_auth_transport_grpc
import grpc

SCOPES = ['https://www.googleapis.com/auth/assistant-sdk-prototype']
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'google-assistant')
CREDENTIALS_FILE = os.path.join(DATA_DIR, 'credentials.json')
DEVICE_CONFIG_FILE = os.path.join(DATA_DIR, 'device_config.json')

# Google Assistant API endpoint
ASSISTANT_API_ENDPOINT = 'embeddedassistant.googleapis.com'


def setup_credentials(client_secret_path: str) -> Credentials:
    """Run OAuth flow and save credentials."""
    os.makedirs(DATA_DIR, exist_ok=True)

    flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, scopes=SCOPES)
    credentials = flow.run_local_server(port=0)

    # Save credentials
    creds_data = {
        'token': credentials.token,
        'refresh_token': credentials.refresh_token,
        'token_uri': credentials.token_uri,
        'client_id': credentials.client_id,
        'client_secret': credentials.client_secret,
        'scopes': list(credentials.scopes or SCOPES),
    }
    with open(CREDENTIALS_FILE, 'w') as f:
        json.dump(creds_data, f, indent=2)
    print(f"Credentials saved to {CREDENTIALS_FILE}")

    return credentials


def register_device(credentials: Credentials) -> dict:
    """Register a device model and instance with Google Assistant."""
    from google.assistant.embedded.v1alpha2 import embedded_assistant_pb2_grpc

    # For device registration we need the project ID from the credentials
    # The user needs to provide this
    project_id = input("Enter your Google Cloud project ID: ").strip()
    if not project_id:
        print("Project ID is required for device registration.")
        sys.exit(1)

    device_model_id = f'{project_id}-nanoclaw-model'
    device_instance_id = f'{project_id}-nanoclaw-instance'

    device_config = {
        'project_id': project_id,
        'device_model_id': device_model_id,
        'device_instance_id': device_instance_id,
    }
    with open(DEVICE_CONFIG_FILE, 'w') as f:
        json.dump(device_config, f, indent=2)
    print(f"Device config saved to {DEVICE_CONFIG_FILE}")

    return device_config


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/google-assistant-setup.py /path/to/client_secret.json")
        sys.exit(1)

    client_secret_path = sys.argv[1]
    if not os.path.isfile(client_secret_path):
        print(f"File not found: {client_secret_path}")
        sys.exit(1)

    print("=== Google Assistant Setup for NanoClaw ===\n")
    print("This will open a browser for Google OAuth authorization.")
    print("Make sure you created Desktop app credentials (not Web app).\n")

    credentials = setup_credentials(client_secret_path)
    device_config = register_device(credentials)

    print(f"\nSetup complete!")
    print(f"  Credentials: {CREDENTIALS_FILE}")
    print(f"  Device config: {DEVICE_CONFIG_FILE}")
    print(f"\nYou can now start the NanoClaw service and use google-home commands.")


if __name__ == '__main__':
    main()
```

**Step 2: Make executable**

```bash
chmod +x scripts/google-assistant-setup.py
```

**Step 3: Commit**

```bash
git add scripts/google-assistant-setup.py
git commit -m "feat: add Google Assistant OAuth setup script"
```

---

### Task 3: Create the Python daemon

**Files:**
- Create: `scripts/google-assistant-daemon.py`

**Step 1: Write the daemon**

Follows the exact same stdin/stdout JSON protocol as `scripts/voice-recognition-service.py`.

```python
#!/usr/bin/env python3
"""
Google Assistant Daemon — stdin/stdout JSON service.

Maintains a persistent gRPC connection to Google Assistant.
Reads JSON commands from stdin (one per line) and writes JSON responses to stdout.

Commands:
  {"cmd": "command", "text": "turn on the lights"}
    → {"status": "ok", "text": "OK, turning on the living room lights."}

  {"cmd": "health"}
    → {"status": "ok"}
"""

import sys
import json
import os
import logging

import google.auth.transport.grpc as google_auth_transport_grpc
import google.auth.transport.requests as google_auth_transport_requests
from google.oauth2.credentials import Credentials
from google.assistant.embedded.v1alpha2 import embedded_assistant_pb2, embedded_assistant_pb2_grpc

logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

ASSISTANT_API_ENDPOINT = 'embeddedassistant.googleapis.com'
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'google-assistant')
CREDENTIALS_FILE = os.path.join(DATA_DIR, 'credentials.json')
DEVICE_CONFIG_FILE = os.path.join(DATA_DIR, 'device_config.json')


def load_credentials() -> Credentials:
    """Load and refresh OAuth credentials."""
    with open(CREDENTIALS_FILE, 'r') as f:
        creds_data = json.load(f)

    credentials = Credentials(
        token=creds_data.get('token'),
        refresh_token=creds_data['refresh_token'],
        token_uri=creds_data.get('token_uri', 'https://oauth2.googleapis.com/token'),
        client_id=creds_data['client_id'],
        client_secret=creds_data['client_secret'],
        scopes=creds_data.get('scopes', ['https://www.googleapis.com/auth/assistant-sdk-prototype']),
    )

    # Refresh if expired
    if not credentials.valid:
        credentials.refresh(google_auth_transport_requests.Request())
        # Save refreshed token
        creds_data['token'] = credentials.token
        with open(CREDENTIALS_FILE, 'w') as f:
            json.dump(creds_data, f, indent=2)

    return credentials


def create_assistant_channel(credentials: Credentials):
    """Create authenticated gRPC channel to Google Assistant."""
    http_request = google_auth_transport_requests.Request()
    channel = google_auth_transport_grpc.secure_authorized_channel(
        credentials, http_request, ASSISTANT_API_ENDPOINT
    )
    return channel


def send_text_query(assistant, device_model_id: str, device_instance_id: str,
                    text: str, conversation_state: bytes | None) -> dict:
    """Send a text query to Google Assistant and return the response."""
    config = embedded_assistant_pb2.AssistConfig(
        text_query=text,
        audio_out_config=embedded_assistant_pb2.AudioOutConfig(
            encoding='LINEAR16',
            sample_rate_hertz=16000,
            volume_percentage=0,  # We don't need audio output
        ),
        device_config=embedded_assistant_pb2.DeviceConfig(
            device_id=device_instance_id,
            device_model_id=device_model_id,
        ),
        dialog_state_in=embedded_assistant_pb2.DialogStateIn(
            language_code='en-US',
            conversation_state=conversation_state or b'',
        ),
    )

    request = embedded_assistant_pb2.AssistRequest(config=config)
    response_text = ''
    new_conversation_state = conversation_state
    html_response = ''

    for response in assistant.Assist(iter([request])):
        if response.dialog_state_out:
            if response.dialog_state_out.supplemental_display_text:
                response_text = response.dialog_state_out.supplemental_display_text
            if response.dialog_state_out.conversation_state:
                new_conversation_state = response.dialog_state_out.conversation_state

        # Some smart home responses come as screen_out HTML
        if response.screen_out and response.screen_out.data:
            html_response = response.screen_out.data.decode('utf-8', errors='replace')

    return {
        'text': response_text,
        'html': html_response,
        'conversation_state': new_conversation_state,
    }


def extract_text_from_html(html: str) -> str:
    """Extract readable text from Google Assistant HTML response."""
    if not html:
        return ''
    try:
        # Simple extraction: strip tags
        import re
        text = re.sub(r'<[^>]+>', ' ', html)
        text = re.sub(r'\s+', ' ', text).strip()
        return text
    except Exception:
        return ''


def main():
    if not os.path.isfile(CREDENTIALS_FILE):
        sys.stderr.write(f"Credentials not found at {CREDENTIALS_FILE}\n")
        sys.stderr.write("Run: python3 scripts/google-assistant-setup.py /path/to/client_secret.json\n")
        sys.exit(1)

    if not os.path.isfile(DEVICE_CONFIG_FILE):
        sys.stderr.write(f"Device config not found at {DEVICE_CONFIG_FILE}\n")
        sys.stderr.write("Run: python3 scripts/google-assistant-setup.py /path/to/client_secret.json\n")
        sys.exit(1)

    log.info("Loading credentials...")
    credentials = load_credentials()

    log.info("Loading device config...")
    with open(DEVICE_CONFIG_FILE, 'r') as f:
        device_config = json.load(f)

    device_model_id = device_config['device_model_id']
    device_instance_id = device_config['device_instance_id']

    log.info("Connecting to Google Assistant API...")
    channel = create_assistant_channel(credentials)
    assistant = embedded_assistant_pb2_grpc.EmbeddedAssistantStub(channel)

    conversation_state = None

    # Signal readiness
    log.info("Google Assistant daemon ready.")
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    # Read commands from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"status": "error", "error": f"invalid JSON: {e}"}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        try:
            command = cmd.get("cmd")

            if command == "health":
                response = {"status": "ok"}

            elif command == "command":
                text = cmd.get("text", "")
                if not text:
                    response = {"status": "error", "error": "missing text field"}
                else:
                    result = send_text_query(
                        assistant, device_model_id, device_instance_id,
                        text, conversation_state
                    )
                    conversation_state = result.get('conversation_state')

                    response_text = result['text']
                    if not response_text and result['html']:
                        response_text = extract_text_from_html(result['html'])

                    response = {
                        "status": "ok",
                        "text": response_text or "(no text response)",
                        "raw_html": result['html'] if result['html'] else None,
                    }

            elif command == "reset_conversation":
                conversation_state = None
                response = {"status": "ok", "text": "Conversation state reset."}

            else:
                response = {"status": "error", "error": f"unknown command: {command}"}

        except Exception as e:
            log.exception(f"Error processing command: {e}")
            # Try to reconnect on gRPC errors
            try:
                credentials = load_credentials()
                channel = create_assistant_channel(credentials)
                assistant = embedded_assistant_pb2_grpc.EmbeddedAssistantStub(channel)
                response = {"status": "error", "error": str(e), "reconnected": True}
            except Exception as reconnect_err:
                response = {"status": "error", "error": f"{e} (reconnect also failed: {reconnect_err})"}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
```

**Step 2: Make executable**

```bash
chmod +x scripts/google-assistant-daemon.py
```

**Step 3: Smoke test** (only possible after Task 2 setup is complete)

```bash
echo '{"cmd": "health"}' | scripts/venv/bin/python3 scripts/google-assistant-daemon.py
```

Expected: First line `{"status": "ready"}`, second line `{"status": "ok"}`

**Step 4: Commit**

```bash
git add scripts/google-assistant-daemon.py
git commit -m "feat: add Google Assistant gRPC daemon"
```

---

### Task 4: Create the TypeScript manager

**Files:**
- Create: `src/google-assistant.ts`

**Step 1: Write the TypeScript manager**

Mirror the pattern from `src/voice-recognition.ts`:

```typescript
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

import { logger } from './logger.js';

const VENV_PYTHON = path.join(process.cwd(), 'scripts', 'venv', 'bin', 'python3');
const PYTHON_DAEMON = path.join(process.cwd(), 'scripts', 'google-assistant-daemon.py');

// Daemon state
let daemon: ChildProcess | null = null;
let daemonRL: readline.Interface | null = null;
let pendingResolve: ((value: any) => void) | null = null;
let pendingReject: ((reason: any) => void) | null = null;
let daemonReady = false;

async function ensureDaemon(): Promise<void> {
  if (daemon && !daemon.killed && daemonReady) return;

  if (daemon) {
    daemon.kill();
    daemon = null;
    daemonRL = null;
    daemonReady = false;
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, [PYTHON_DAEMON], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr!.on('data', (data: Buffer) => {
      logger.info({ msg: data.toString().trim() }, 'google-assistant-daemon');
    });

    proc.on('error', (err) => {
      logger.error({ err }, 'Failed to spawn Google Assistant daemon');
      daemon = null;
      daemonReady = false;
      reject(err);
    });

    proc.on('exit', (code) => {
      logger.info({ code }, 'Google Assistant daemon exited');
      daemon = null;
      daemonRL = null;
      daemonReady = false;
      if (pendingReject) {
        pendingReject(new Error(`Daemon exited with code ${code}`));
        pendingResolve = null;
        pendingReject = null;
      }
    });

    const rl = readline.createInterface({ input: proc.stdout! });

    rl.on('line', (line: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn({ line }, 'Non-JSON line from Google Assistant daemon');
        return;
      }

      if (!daemonReady && parsed.status === 'ready') {
        daemonReady = true;
        resolve();
        return;
      }

      if (pendingResolve) {
        const res = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        res(parsed);
      }
    });

    daemon = proc;
    daemonRL = rl;

    // Timeout: gRPC connection should be fast (30s)
    setTimeout(() => {
      if (!daemonReady) {
        proc.kill();
        reject(new Error('Google Assistant daemon timed out'));
      }
    }, 30_000);
  });
}

async function sendCommand(cmd: Record<string, unknown>): Promise<any> {
  await ensureDaemon();

  if (!daemon || !daemon.stdin) {
    throw new Error('Google Assistant daemon not available');
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;

    daemon!.stdin!.write(JSON.stringify(cmd) + '\n');

    setTimeout(() => {
      if (pendingReject) {
        pendingReject(new Error('Google Assistant command timed out'));
        pendingResolve = null;
        pendingReject = null;
      }
    }, 30_000);
  });
}

// ── Public API ────────────────────────────────────────────────────

export interface GoogleAssistantResponse {
  status: string;
  text?: string;
  error?: string;
  raw_html?: string;
}

/**
 * Send a text command to Google Assistant.
 * Returns the assistant's text response.
 */
export async function sendGoogleAssistantCommand(text: string): Promise<GoogleAssistantResponse> {
  return sendCommand({ cmd: 'command', text });
}

/**
 * Reset the conversation state (multi-turn context).
 */
export async function resetGoogleAssistantConversation(): Promise<GoogleAssistantResponse> {
  return sendCommand({ cmd: 'reset_conversation' });
}

/**
 * Check daemon health.
 */
export async function googleAssistantHealth(): Promise<GoogleAssistantResponse> {
  return sendCommand({ cmd: 'health' });
}

/**
 * Shut down the daemon (call on process exit).
 */
export function shutdownGoogleAssistant(): void {
  if (daemon && !daemon.killed) {
    daemon.kill();
    daemon = null;
    daemonRL = null;
    daemonReady = false;
  }
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/google-assistant.ts
```

Expected: No errors

**Step 3: Commit**

```bash
git add src/google-assistant.ts
git commit -m "feat: add Google Assistant TypeScript manager"
```

---

### Task 5: Add IPC handler for Google Assistant commands

**Files:**
- Modify: `src/ipc.ts` (add `google_assistant_command` case)
- Modify: `src/container-runner.ts` (add `responses/` IPC subdirectory)

**Step 1: Add `responses/` directory to container IPC mount**

In `src/container-runner.ts`, after line 192 (`fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });`), add:

```typescript
  fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
```

**Step 2: Add Google Assistant IPC handler**

In `src/ipc.ts`, add the import at the top:

```typescript
import { sendGoogleAssistantCommand, resetGoogleAssistantConversation } from './google-assistant.js';
```

Then add a new case in the `processTaskIpc` switch statement, before the `default:` case:

```typescript
    case 'google_assistant_command': {
      const requestId = data.requestId as string | undefined;
      const text = data.text as string | undefined;
      if (!requestId || !text) {
        logger.warn({ data }, 'Invalid google_assistant_command: missing requestId or text');
        break;
      }

      try {
        const result = text === '__reset_conversation__'
          ? await resetGoogleAssistantConversation()
          : await sendGoogleAssistantCommand(text);

        // Write response to the group's responses directory
        const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
        fs.mkdirSync(responsesDir, { recursive: true });
        const responseFile = path.join(responsesDir, `${requestId}.json`);
        const tempFile = `${responseFile}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(result));
        fs.renameSync(tempFile, responseFile);

        logger.info({ requestId, sourceGroup, text: text.slice(0, 50) }, 'Google Assistant command processed');
      } catch (err) {
        // Write error response
        const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
        fs.mkdirSync(responsesDir, { recursive: true });
        const responseFile = path.join(responsesDir, `${requestId}.json`);
        const tempFile = `${responseFile}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
        fs.renameSync(tempFile, responseFile);

        logger.error({ err, requestId, sourceGroup }, 'Google Assistant command failed');
      }
      break;
    }
```

Also update the `processTaskIpc` `data` parameter type to include the new fields:

```typescript
    requestId?: string;
    text?: string;
```

**Step 3: Add shutdown call in `src/index.ts`**

Import at top:

```typescript
import { shutdownGoogleAssistant } from './google-assistant.js';
```

In the `shutdown` function (around line 459), before `process.exit(0)`:

```typescript
    shutdownGoogleAssistant();
```

**Step 4: Verify build**

```bash
npm run build
```

Expected: No errors

**Step 5: Commit**

```bash
git add src/ipc.ts src/container-runner.ts src/index.ts
git commit -m "feat: add Google Assistant IPC handler and response directory"
```

---

### Task 6: Create the Bash wrapper script

**Files:**
- Create: `container/skills/google-home/google-home`

This is the Bash script that agents call from inside containers. It writes IPC task files, polls for responses.

**Step 1: Write the Bash wrapper**

```bash
#!/usr/bin/env bash
# google-home — Google Home control via IPC
# Called from inside containers as: google-home:command "text"
# or: google-home:status, google-home:reset

set -euo pipefail

IPC_DIR="/workspace/ipc"
TASKS_DIR="$IPC_DIR/tasks"
RESPONSES_DIR="$IPC_DIR/responses"
POLL_INTERVAL=0.5
POLL_TIMEOUT=30

# Generate unique request ID
request_id="gh-$(date +%s)-$(head -c 6 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 8)"

write_task() {
  local text="$1"
  local tmpfile="$TASKS_DIR/${request_id}.json.tmp"
  local taskfile="$TASKS_DIR/${request_id}.json"

  cat > "$tmpfile" <<ENDJSON
{
  "type": "google_assistant_command",
  "requestId": "$request_id",
  "text": "$text",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON

  mv "$tmpfile" "$taskfile"
}

poll_response() {
  local response_file="$RESPONSES_DIR/${request_id}.json"
  local elapsed=0

  while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
    if [ -f "$response_file" ]; then
      cat "$response_file"
      rm -f "$response_file"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + 1))
  done

  echo '{"status": "error", "error": "Timed out waiting for response"}'
  return 1
}

# Parse the subcommand (google-home:command, google-home:status, etc.)
# When called as "google-home:command", $0 is "google-home" and
# the skill engine passes the subcommand as part of the invocation.
subcommand="${1:-help}"
shift || true

case "$subcommand" in
  command)
    text="$*"
    if [ -z "$text" ]; then
      echo "Usage: google-home:command \"turn on the living room lights\""
      exit 1
    fi
    write_task "$text"
    poll_response | jq -r 'if .status == "ok" then .text else "Error: " + .error end'
    ;;

  status)
    write_task "__health__"
    # For health check, modify the task slightly
    tmpfile="$TASKS_DIR/${request_id}.json.tmp"
    taskfile="$TASKS_DIR/${request_id}.json"
    cat > "$tmpfile" <<ENDJSON
{
  "type": "google_assistant_command",
  "requestId": "$request_id",
  "text": "__health__",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON
    mv "$tmpfile" "$taskfile"
    poll_response
    ;;

  reset)
    write_task "__reset_conversation__"
    poll_response | jq -r '.text // .error // "Conversation reset."'
    ;;

  automation)
    # Automation subcommands are handled by the skill markdown
    # The agent generates YAML directly — no IPC needed
    echo "Automation commands:"
    echo "  generate - Generate a YAML automation script (use the skill instructions)"
    echo "  push     - Push a YAML script to Google Home via agent-browser"
    ;;

  help|*)
    echo "google-home — Control Google Home smart devices"
    echo ""
    echo "Commands:"
    echo "  google-home:command \"turn on the lights\"  — Send a command"
    echo "  google-home:status                         — Check connection"
    echo "  google-home:reset                          — Reset conversation"
    echo "  google-home:automation generate            — Generate automation YAML"
    echo "  google-home:automation push                — Push YAML via browser"
    ;;
esac
```

**Step 2: Make executable**

```bash
chmod +x container/skills/google-home/google-home
```

**Step 3: Commit**

```bash
git add container/skills/google-home/google-home
git commit -m "feat: add google-home Bash wrapper for container IPC"
```

---

### Task 7: Create the container skill SKILL.md

**Files:**
- Create: `container/skills/google-home/SKILL.md`

**Step 1: Write the skill markdown**

This is the largest file — it teaches the agent how to use google-home commands and how to generate Google Home automation YAML.

```markdown
---
name: google-home
description: Control smart home devices via Google Assistant and create/manage Google Home automations. Use whenever the user wants to control lights, thermostat, locks, or other smart home devices, or create home automations.
allowed-tools: Bash(google-home:*)
---

# Google Home Control

## Smart Home Devices

<!-- UPDATE THIS LIST with your actual device names from Google Home -->
Known devices in this household:
- (placeholder) Living Room Lights — light group
- (placeholder) Bedroom Light — single light
- (placeholder) Kitchen Light — single light
- (placeholder) Thermostat — Nest thermostat
- (placeholder) Front Door Lock — smart lock
- (placeholder) Living Room TV — Chromecast/smart TV

**Update the list above** with actual device names from your Google Home app.

## Quick Start

```bash
# Control devices
google-home:command "turn on the living room lights"
google-home:command "set the thermostat to 72"
google-home:command "dim the bedroom light to 50 percent"
google-home:command "lock the front door"
google-home:command "what temperature is the thermostat set to?"

# Check status
google-home:status

# Reset conversation (clears multi-turn context)
google-home:reset
```

## Tips

- Use the exact device names as they appear in Google Home
- Multi-turn works: "turn on the lights" → "now dim them to 50%"
- Queries return text: "what's the temperature?" → "The thermostat is set to 72°F"
- If a command gets no text response, try rephrasing it

## Google Home Automations

You can generate YAML automation scripts for the Google Home script editor. The user can paste them into the Google Home app/web, or you can push them via agent-browser.

### Automation YAML Schema

Automations have this structure:

```yaml
metadata:
  name: My Automation
  description: What this automation does

automations:
  - starters:
      - type: <starter_type>
        # starter-specific fields
    condition:
      type: <condition_type>
      # condition-specific fields
    actions:
      - type: <action_type>
        # action-specific fields
```

### Starters (Triggers)

| Type | Description | Key Fields |
|------|-------------|------------|
| `time.schedule` | At a specific time | `at: "HH:MM"` or `at: "sunrise"` / `"sunset"` (with optional offset like `"sunset+30min"`) |
| `device.state.OnOff` | Device turns on/off | `device: "Name - Room"`, `state: "on"` or `"off"` |
| `device.state.Brightness` | Brightness changes | `device: "Name - Room"`, `brightness:` (0-100) |
| `device.state.TemperatureAmbient` | Temperature changes | `device: "Name - Room"`, `temperatureAmbient:` (e.g., `"18C"`) |
| `device.state.OpenClose` | Door/blind opens/closes | `device: "Name - Room"`, `openPercent:` (0-100) |
| `device.state.LockUnlock` | Lock state changes | `device: "Name - Room"`, `isLocked: true/false` |
| `device.event.MotionDetection` | Motion detected | `device: "Camera - Room"` |
| `device.event.DoorbellPress` | Doorbell pressed | `device: "Doorbell - Front"` |
| `home.state.HomePresence` | Someone arrives/leaves | `state: "HOME"` or `"AWAY"` |
| `assistant.event.OkGoogle` | Voice command | `query: "movie night"` |

### Conditions

| Type | Description | Key Fields |
|------|-------------|------------|
| `time.between` | Time window | `after: "HH:MM"`, `before: "HH:MM"` (or sunrise/sunset) |
| `time.between` (weekday) | Day of week | `weekday:` array of `MONDAY`, `TUESDAY`, etc. |
| `device.state.*` | Device in state | Same as starters |
| `home.state.HomePresence` | Home/Away | `state: "HOME"` or `"AWAY"` |
| `and` | All conditions | `conditions:` array |
| `or` | Any condition | `conditions:` array |
| `not` | Negate | `condition:` single condition |

### Actions

| Type | Description | Key Fields |
|------|-------------|------------|
| `device.command.OnOff` | Turn on/off | `devices: "Name - Room"`, `on: true/false` |
| `device.command.BrightnessAbsolute` | Set brightness | `devices: "Name - Room"`, `brightness:` (0-100) |
| `device.command.ColorAbsolute` | Set color | `devices: "Name - Room"`, `color:` hex or `colorTemperature:` K |
| `device.command.ThermostatTemperatureSetpoint` | Set temp | `devices: "Name - Room"`, `thermostatTemperatureSetpoint:` e.g. `"22C"` |
| `device.command.OpenClose` | Open/close | `devices: "Name - Room"`, `openPercent:` (0-100) |
| `device.command.LockUnlock` | Lock/unlock | `devices: "Name - Room"`, `lock: true/false` |
| `device.command.SetVolume` | Set volume | `devices: "Name - Room"`, `volumeLevel:` (0-100) |
| `device.command.LightEffectPulse` | Pulse light | `devices: "Name - Room"`, `color:` hex, `duration: "5min"` |
| `time.delay` | Wait | `for: "30sec"` or `"5min"` |
| `notification` | Send notification | `title:`, `body:`, `recipients:` array of emails |

### Data Types

- **Time**: `"13:00"`, `"sunrise"`, `"sunset+30min"`, `"sunrise-15min"`
- **Temperature**: `"22C"`, `"72F"`
- **Duration**: `"30sec"`, `"5min"`, `"1hour"`
- **Entity**: `"Device Name - Room Name"` (exact match from Google Home)
- **Color**: six-digit hex without `#` (e.g., `"FF0000"` for red)
- **Weekday**: `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`, `SUNDAY`

### Suppression

Add `suppressFor: "20hour"` to a starter to prevent it from re-triggering within that window.

### Example Automations

**Dim lights at 10pm:**
```yaml
metadata:
  name: Evening Dim
  description: Dim living room lights at 10pm

automations:
  - starters:
      - type: time.schedule
        at: "22:00"
    actions:
      - type: device.command.BrightnessAbsolute
        devices: Living Room Lights - Living Room
        brightness: 50
```

**Turn off lights when everyone leaves:**
```yaml
metadata:
  name: Away Lights Off
  description: Turn off all lights when nobody is home

automations:
  - starters:
      - type: home.state.HomePresence
        state: AWAY
    actions:
      - type: device.command.OnOff
        devices: Living Room Lights - Living Room
        on: false
      - type: device.command.OnOff
        devices: Kitchen Light - Kitchen
        on: false
      - type: device.command.OnOff
        devices: Bedroom Light - Bedroom
        on: false
```

**Motion-activated night light:**
```yaml
metadata:
  name: Night Motion Light
  description: Turn on hallway light when motion detected at night

automations:
  - starters:
      - type: device.event.MotionDetection
        device: Hallway Camera - Hallway
    condition:
      type: time.between
      after: sunset
      before: sunrise
    actions:
      - type: device.command.OnOff
        devices: Hallway Light - Hallway
        on: true
      - type: device.command.BrightnessAbsolute
        devices: Hallway Light - Hallway
        brightness: 30
```

**Movie night voice command:**
```yaml
metadata:
  name: Movie Night
  description: Set up movie night when you say "movie night"

automations:
  - starters:
      - type: assistant.event.OkGoogle
        query: "movie night"
    actions:
      - type: device.command.OnOff
        devices: Living Room Lights - Living Room
        on: false
      - type: device.command.SetVolume
        devices: Living Room TV - Living Room
        volumeLevel: 40
```

### Pushing Automations via Browser

To push a generated YAML script to Google Home via agent-browser:

1. Save the YAML to a file: `/tmp/automation.yaml`
2. Use agent-browser to navigate to `home.google.com`
3. Navigate to Automations → Script Editor
4. Paste the YAML content
5. Save

This is best-effort — the web UI can change. If it fails, give the YAML to the user to paste manually.
```

**Step 2: Commit**

```bash
git add container/skills/google-home/SKILL.md
git commit -m "feat: add google-home container skill with automation schema reference"
```

---

### Task 8: Install Bash wrapper in container

**Files:**
- Modify: `container/Dockerfile` (or `container/entrypoint.sh`)

The Bash wrapper needs to be available as `google-home` in the container's PATH so the skill's `allowed-tools: Bash(google-home:*)` works.

**Step 1: Check how agent-browser is installed**

Look at the Dockerfile to understand how `agent-browser` gets into the container PATH, and follow the same pattern for `google-home`.

```bash
grep -n 'agent-browser' container/Dockerfile container/entrypoint.sh 2>/dev/null
```

**Step 2: Add google-home wrapper to the container build**

Follow the same pattern as agent-browser. The skill files are already synced to the container's `.claude/skills/` directory (Task 7 puts the Bash wrapper alongside SKILL.md). We need to ensure the `google-home` script is in PATH.

Add to `container/Dockerfile` or `container/entrypoint.sh` (wherever agent-browser is installed), something like:

```dockerfile
COPY skills/google-home/google-home /usr/local/bin/google-home
RUN chmod +x /usr/local/bin/google-home
```

Or if skills are synced dynamically, add a symlink in entrypoint.sh.

**Step 3: Verify `jq` is available in the container**

The Bash wrapper uses `jq`. Check if it's already in the Dockerfile:

```bash
grep -n 'jq' container/Dockerfile
```

If not, add it to the apt-get install line.

**Step 4: Rebuild container**

```bash
./container/build.sh
```

**Step 5: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: install google-home wrapper in container"
```

---

### Task 9: Handle health check edge case in IPC

**Files:**
- Modify: `src/ipc.ts`

The Bash wrapper sends `"__health__"` as the text for health checks. Update the IPC handler to handle this:

**Step 1: Update the google_assistant_command case**

In the IPC handler (from Task 5), update the command dispatch:

```typescript
        const result =
          text === '__reset_conversation__'
            ? await resetGoogleAssistantConversation()
            : text === '__health__'
              ? await googleAssistantHealth()
              : await sendGoogleAssistantCommand(text);
```

Also add `googleAssistantHealth` to the import from `./google-assistant.js`.

**Step 2: Build and verify**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: handle health check in Google Assistant IPC handler"
```

---

### Task 10: End-to-end test

**Step 1: Run OAuth setup** (if not already done)

```bash
scripts/venv/bin/python3 scripts/google-assistant-setup.py /path/to/client_secret.json
```

Follow the browser prompts. Enter your GCP project ID when asked.

**Step 2: Test daemon directly**

```bash
echo '{"cmd": "health"}' | scripts/venv/bin/python3 scripts/google-assistant-daemon.py
```

Expected: `{"status": "ready"}` then `{"status": "ok"}`

**Step 3: Test a smart home command**

```bash
echo -e '{"cmd": "command", "text": "what time is it"}\n' | scripts/venv/bin/python3 scripts/google-assistant-daemon.py
```

Expected: `{"status": "ready"}` then a response with current time

**Step 4: Build and deploy**

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw
```

**Step 5: Test from WhatsApp**

Send a message to the bot: "@Andy turn on the living room lights"

The agent should use the google-home skill to send the command.

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: Google Home integration — complete"
```
