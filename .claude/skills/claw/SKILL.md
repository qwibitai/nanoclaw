---
name: claw
description: Install the claw CLI tool — run NanoClaw agent containers from the command line without opening a chat app.
author: kenbolton
---

# claw — NanoClaw CLI

`claw` is a Python CLI script that lets you send prompts directly to a NanoClaw agent container from your terminal. It reads registered groups from the NanoClaw database, picks up your secrets from `.env`, and pipes a JSON payload into a container run — no chat app required.

## What it does

- Send a prompt to any registered group by name, folder, or JID
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `--list-groups`
- Auto-detects `container` or `docker` runtime (or override with `--runtime`)
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the command, redacted payload, and exit code

## Prerequisites

- Python 3.8 or later
- NanoClaw installed at `~/src/nanoclaw` with a built and tagged container image (`nanoclaw-agent:latest`)
- Either `container` (Apple Container, macOS 15+) or `docker` available in `PATH`

## Install

> **Note:** Run this skill from within your NanoClaw directory (`cd ~/src/nanoclaw` or wherever you installed it). The script auto-detects its location, so the symlink always points to the right place.

### 1. Write the script

Create the scripts directory if it doesn't exist, then write the script:

```bash
mkdir -p scripts
```

Write the following to `scripts/claw`:

```python
#!/usr/bin/env python3
"""
claw — NanoClaw CLI
Run a NanoClaw agent container from the command line.

Usage:
  claw "What is 2+2?"
  claw -g <channel_name> "Review this code"
  claw -g "<channel name with spaces>" "What's the latest issue?"
  claw -j "<chatJid>" "Hello"
  claw -g <channel_name> -s <session-id> "Continue"
  claw --list-groups
  echo "prompt text" | claw --pipe -g <channel_name>
  cat prompt.txt | claw --pipe
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

# ── Globals ─────────────────────────────────────────────────────────────────

VERBOSE = False

def dbg(*args):
    if VERBOSE:
        print("»", *args, file=sys.stderr)

# ── Config ──────────────────────────────────────────────────────────────────

def _find_nanoclaw_dir() -> Path:
    """Locate the NanoClaw installation directory.

    Resolution order:
    1. NANOCLAW_DIR env var
    2. The directory containing this script (if it looks like a NanoClaw install)
    3. ~/src/nanoclaw (legacy default)
    """
    if env := os.environ.get("NANOCLAW_DIR"):
        return Path(env).expanduser()
    # If this script lives inside the NanoClaw tree (e.g. scripts/claw), walk up
    here = Path(__file__).resolve()
    for parent in [here.parent, here.parent.parent]:
        if (parent / "store" / "messages.db").exists() or (parent / ".env").exists():
            return parent
    return Path.home() / "src" / "nanoclaw"

NANOCLAW_DIR = _find_nanoclaw_dir()
DB_PATH      = NANOCLAW_DIR / "store" / "messages.db"
ENV_FILE     = NANOCLAW_DIR / ".env"
IMAGE        = "nanoclaw-agent:latest"

SECRET_KEYS = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "OLLAMA_HOST",
]

# ── Helpers ──────────────────────────────────────────────────────────────────

def detect_runtime(preference: str | None) -> str:
    if preference:
        dbg(f"runtime: forced to {preference}")
        return preference
    for rt in ("container", "docker"):
        result = subprocess.run(["which", rt], capture_output=True)
        if result.returncode == 0:
            dbg(f"runtime: auto-detected {rt} at {result.stdout.decode().strip()}")
            return rt
    sys.exit("error: neither 'container' nor 'docker' found. Install one or pass --runtime.")


def read_secrets(env_file: Path) -> dict:
    secrets = {}
    if not env_file.exists():
        return secrets
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            key = key.strip()
            if key in SECRET_KEYS:
                secrets[key] = val.strip()
    return secrets


def get_groups(db: Path) -> list[dict]:
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT jid, name, folder, is_main FROM registered_groups ORDER BY name"
    ).fetchall()
    conn.close()
    return [{"jid": r[0], "name": r[1], "folder": r[2], "is_main": bool(r[3])} for r in rows]


def find_group(groups: list[dict], query: str) -> dict | None:
    q = query.lower()
    # Exact name match
    for g in groups:
        if g["name"].lower() == q or g["folder"].lower() == q:
            return g
    # Partial match
    matches = [g for g in groups if q in g["name"].lower() or q in g["folder"].lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        names = ", ".join(f'"{g["name"]}"' for g in matches)
        sys.exit(f"error: ambiguous group '{query}'. Matches: {names}")
    return None


def run_container(runtime: str, image: str, payload: dict, timeout: int = 300) -> None:
    cmd = [runtime, "run", "-i", "--rm", image]
    dbg(f"cmd: {' '.join(cmd)}")

    # Show payload sans secrets
    if VERBOSE:
        safe = {k: v for k, v in payload.items() if k != "secrets"}
        safe["secrets"] = {k: "***" for k in payload.get("secrets", {})}
        dbg(f"payload: {json.dumps(safe, indent=2)}")

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    dbg(f"container pid: {proc.pid}")

    # Write JSON payload and close stdin
    proc.stdin.write(json.dumps(payload).encode())
    proc.stdin.close()
    dbg("stdin closed, waiting for response...")

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    done = threading.Event()

    def stream_stderr():
        for raw in proc.stderr:
            line = raw.decode(errors="replace").rstrip()
            if line.startswith("npm notice"):
                continue
            stderr_lines.append(line)
            print(line, file=sys.stderr)

    def stream_stdout():
        for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            stdout_lines.append(line)
            dbg(f"stdout: {line}")
            # Kill the container as soon as we see the closing sentinel —
            # the Node.js event loop often keeps the process alive indefinitely.
            if line.strip() == "---NANOCLAW_OUTPUT_END---":
                dbg("output sentinel found, terminating container")
                done.set()
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                return

    t_err = threading.Thread(target=stream_stderr, daemon=True)
    t_out = threading.Thread(target=stream_stdout, daemon=True)
    t_err.start()
    t_out.start()

    # Wait for sentinel or timeout
    if not done.wait(timeout=timeout):
        # Also check if process exited naturally
        t_out.join(timeout=2)
        if not done.is_set():
            proc.kill()
            sys.exit(f"error: container timed out after {timeout}s (no output sentinel received)")

    t_err.join(timeout=5)
    t_out.join(timeout=5)
    proc.wait()
    dbg(f"container done (rc={proc.returncode}), {len(stdout_lines)} stdout lines")
    stdout = "\n".join(stdout_lines)

    # Parse output block
    match = re.search(
        r"---NANOCLAW_OUTPUT_START---\n(.*?)\n---NANOCLAW_OUTPUT_END---",
        stdout,
        re.DOTALL,
    )
    if match:
        try:
            data = json.loads(match.group(1))
            status = data.get("status", "unknown")
            if status == "success":
                print(data.get("result", ""))
                session_id = data.get("newSessionId") or data.get("sessionId")
                if session_id:
                    print(f"\n[session: {session_id}]", file=sys.stderr)
            else:
                print(f"[{status}] {data.get('result', '')}", file=sys.stderr)
                sys.exit(1)
        except json.JSONDecodeError:
            print(match.group(1))
    else:
        # No structured output — print raw stdout
        print(stdout)

    if proc.returncode not in (0, None):
        sys.exit(proc.returncode)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="claw",
        description="Run a NanoClaw agent from the command line.",
    )
    parser.add_argument("prompt", nargs="?", help="Prompt to send")
    parser.add_argument("-g", "--group", help="Group name or folder (fuzzy match)")
    parser.add_argument("-j", "--jid", help="Chat JID (exact)")
    parser.add_argument("-s", "--session", help="Session ID to resume")
    parser.add_argument("-p", "--pipe", action="store_true",
                        help="Read prompt from stdin (can be combined with a prompt arg as prefix)")
    parser.add_argument("--runtime", choices=["docker", "container"],
                        help="Container runtime (default: auto-detect)")
    parser.add_argument("--image", default=IMAGE, help=f"Container image (default: {IMAGE})")
    parser.add_argument("--list-groups", action="store_true", help="List registered groups and exit")
    parser.add_argument("--raw", action="store_true", help="Print raw JSON output")
    parser.add_argument("--timeout", type=int, default=300, metavar="SECS",
                        help="Max seconds to wait for a response (default: 300)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Show debug info: cmd, payload (secrets redacted), stdout lines, exit code")
    args = parser.parse_args()

    global VERBOSE
    VERBOSE = args.verbose

    groups = get_groups(DB_PATH) if DB_PATH.exists() else []

    if args.list_groups:
        print(f"{'NAME':<35} {'FOLDER':<30} {'JID'}")
        print("-" * 100)
        for g in groups:
            main_tag = " [main]" if g["is_main"] else ""
            print(f"{g['name']:<35} {g['folder']:<30} {g['jid']}{main_tag}")
        return

    # Resolve prompt: --pipe reads stdin, optionally prepended with positional arg
    if args.pipe or (not sys.stdin.isatty() and not args.prompt):
        stdin_text = sys.stdin.read().strip()
        if args.prompt:
            prompt = f"{args.prompt}\n\n{stdin_text}"
        else:
            prompt = stdin_text
    else:
        prompt = args.prompt

    if not prompt:
        parser.print_help()
        sys.exit(1)

    # Resolve group → jid
    jid = args.jid
    group_name = None
    is_main = False

    if args.group:
        g = find_group(groups, args.group)
        if g is None:
            sys.exit(f"error: group '{args.group}' not found. Run --list-groups to see options.")
        jid = g["jid"]
        group_name = g["name"]
        is_main = g["is_main"]
    elif not jid:
        # Default: main group
        mains = [g for g in groups if g["is_main"]]
        if mains:
            jid = mains[0]["jid"]
            group_name = mains[0]["name"]
            is_main = True
        else:
            sys.exit("error: no group specified and no main group found. Use -g or -j.")

    runtime = detect_runtime(args.runtime)
    secrets = read_secrets(ENV_FILE)

    if not secrets:
        print("warning: no secrets found in .env — agent may not be authenticated", file=sys.stderr)

    payload: dict = {
        "prompt": prompt,
        "chatJid": jid,
        "isMain": is_main,
        "secrets": secrets,
    }
    if group_name:
        payload["groupFolder"] = group_name
    if args.session:
        payload["sessionId"] = args.session
        payload["resumeAt"] = "latest"

    print(f"[{group_name or jid}] running via {runtime}...", file=sys.stderr)
    run_container(runtime, args.image, payload, timeout=args.timeout)


if __name__ == "__main__":
    main()
```

### 2. Make executable and symlink

```bash
chmod +x scripts/claw
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw" ~/bin/claw
```

Make sure `~/bin` is in your `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload your shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
claw --list-groups
```

You should see your registered groups. If NanoClaw isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group
claw "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
claw -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
claw -j "120363336345536173@g.us" "Hello"

# Resume a previous session
claw -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | claw --pipe -g dev

# Pipe a file
cat report.txt | claw --pipe "Summarize this report"

# List all registered groups
claw --list-groups

# Force a specific runtime
claw --runtime docker "Hello"

# Use a custom image tag (e.g. after rebuilding with a new tag)
claw --image nanoclaw-agent:dev "Hello"

# Verbose mode (debug info, secrets redacted)
claw -v "Hello"

# Custom timeout for long-running tasks
claw --timeout 600 "Run the full analysis"
```

## Troubleshooting

### "neither 'container' nor 'docker' found"

Install Docker Desktop or Apple Container (macOS 15+), or pass `--runtime` explicitly.

### "no secrets found in .env"

The script auto-detects your NanoClaw directory and reads `.env` from it. Check that the file exists and contains at least one of: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Container times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the container consistently hangs, check that your `nanoclaw-agent:latest` image is up to date by running `./container/build.sh` in your NanoClaw directory.

### "group not found"

Run `claw --list-groups` to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Container crashes mid-stream

`claw` runs containers with `--rm`, so they are automatically removed whether they exit cleanly or crash. If the agent crashes before emitting the output sentinel, `claw` will fall back to printing raw stdout. Use `-v` to see what the container produced. Rebuild the image with `./container/build.sh` if crashes are consistent.

### Use a custom image tag

If you built the image with a different tag (e.g. during development), pass `--image`:

```bash
claw --image nanoclaw-agent:dev "Hello"
```

Set `NANOCLAW_IMAGE=nanoclaw-agent:dev` in your shell profile to make it the default.

### Override the NanoClaw directory

If `claw` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```

Or add it permanently to your shell profile.
