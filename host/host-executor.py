#!/usr/bin/env python3
"""
Atlas Host-Executor Bridge

Watches ~/.atlas/host-tasks/pending/ for task request JSON files.
For each task:
  1. Validate tier (reject Tier 4, restrict Tier 1 to read-only)
  2. cd to project directory
  3. Run: claude -p --model {model} "prompt"
  4. Capture stdout + exit code
  5. Write result to ~/.atlas/host-tasks/completed/{task-id}.json
  6. Auto-push commits to origin
  7. Log to audit

This runs on the VPS host (not in a container) so full Python hooks fire.
Systemd service: atlas-host-executor.service
"""

import json
import os
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Paths
ATLAS_DIR = Path.home() / ".atlas"
PENDING_DIR = ATLAS_DIR / "host-tasks" / "pending"
COMPLETED_DIR = ATLAS_DIR / "host-tasks" / "completed"
OUTPUTS_DIR = ATLAS_DIR / "host-tasks" / "outputs"
AUDIT_DIR = ATLAS_DIR / "audit"
NANOCLAW_DIR = Path.home() / "nanoclaw"
IPC_DIR = NANOCLAW_DIR / "data" / "ipc" / "atlas_main" / "messages"

# Config
POLL_INTERVAL = 5  # seconds
TASK_TIMEOUT = 300  # 5 minutes max per task
MAX_OUTPUT_SIZE = 50_000  # chars to keep in result summary
AUTH_ERROR_PATTERNS = ["authentication_error", "OAuth token has expired", "401", "token expired"]
OUTAGE_ERROR_PATTERNS = [
    "500 internal server error", "502 bad gateway", "503 service",
    "529", "overloaded", "connection refused", "connection reset",
    "service temporarily unavailable", "outage recovery in progress",
]

# Outage tracking — self-healing mode
outage_mode = False
outage_started_at = 0.0
outage_alert_sent = False
HEALTH_CHECK_BACKOFF = [30, 60, 120, 300]  # seconds: 30s → 1m → 2m → 5m cap
health_check_attempt = 0
QUALITY_CHECK_PORT = 3002


# --- Quality Check HTTP Server ---
# Runs in a background thread. Containers POST response text here,
# host-executor calls Haiku with the real API key, returns the score.
# This avoids putting API keys in containers and works around OAuth
# not being supported on the /v1/messages endpoint.

def _load_anthropic_api_key() -> str:
    """Read ANTHROPIC_API_KEY from ~/.atlas/.env or environment."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    env_path = ATLAS_DIR / ".env"
    try:
        for line in env_path.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return ""


def _call_haiku(response_text: str) -> dict:
    """Call Haiku /v1/messages with direct API key. Returns parsed eval."""
    api_key = _load_anthropic_api_key()
    if not api_key:
        return {"score": -1, "error": "ANTHROPIC_API_KEY not found in ~/.atlas/.env or env"}

    # Import the quality check prompt from the container source if available,
    # otherwise use a minimal fallback. The container source is the single
    # source of truth for the prompt text.
    prompt_file = NANOCLAW_DIR / "container" / "agent-runner" / "src" / "governance" / "response-interceptor.ts"
    quality_prompt = None
    try:
        content = prompt_file.read_text()
        # Extract the prompt between backtick-delimited string
        start = content.find("const QUALITY_CHECK_PROMPT = `")
        if start >= 0:
            start = content.find("`", start) + 1
            end = content.find("`;", start)
            if end > start:
                quality_prompt = content[start:end]
    except Exception:
        pass

    if not quality_prompt:
        quality_prompt = (
            "You are a quality checker. Score this response 0-100 on plain language. "
            "Return JSON: {\"score\": N, \"violations\": []}\n\n<response>\n{RESPONSE}\n</response>"
        )

    filled_prompt = quality_prompt.replace("{RESPONSE}", response_text[:4000])

    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 512,
        "messages": [{"role": "user", "content": filled_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data.get("content", [{}])[0].get("text", "{}")
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            result = json.loads(text)
            return result
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8")[:500]
        except Exception:
            pass
        return {"score": -1, "error": f"HTTP {e.code}: {err_body}"}
    except urllib.error.URLError as e:
        return {"score": -3, "error": f"Network error: {e.reason}"}
    except json.JSONDecodeError as e:
        return {"score": -2, "error": f"JSON parse error: {str(e)}"}
    except TimeoutError:
        return {"score": -4, "error": "timeout"}
    except Exception as e:
        return {"score": -1, "error": str(e)}


class QualityCheckHandler(BaseHTTPRequestHandler):
    """Handles POST /quality-check from containers."""

    def do_POST(self):
        if self.path != "/quality-check":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error": "not found"}')
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            response_text = body.get("response", "")

            if not response_text:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "missing response field"}')
                return

            result = _call_haiku(response_text)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))

        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({"score": -1, "error": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        # Suppress default stderr logging — we use our own log()
        pass


def start_quality_check_server():
    """Start the quality check HTTP server in a background thread."""
    server = HTTPServer(("0.0.0.0", QUALITY_CHECK_PORT), QualityCheckHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log(f"Quality check server started on port {QUALITY_CHECK_PORT}")

# Tier restrictions
TIER_READONLY_FLAG = "--allowedTools Read,Glob,Grep,WebSearch,WebFetch"


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def send_telegram_alert(message: str) -> None:
    """Send an alert to CEO via NanoClaw's IPC system (atlas_main group)."""
    try:
        IPC_DIR.mkdir(parents=True, exist_ok=True)
        # Read main group JID from NanoClaw DB
        import sqlite3
        db_path = NANOCLAW_DIR / "store" / "messages.db"
        if not db_path.exists():
            log(f"Cannot send Telegram alert — DB not found at {db_path}")
            return
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1").fetchone()
        conn.close()
        if not row:
            log("Cannot send Telegram alert — no main group registered")
            return
        main_jid = row[0]

        alert_file = IPC_DIR / f"alert-{int(time.time() * 1000)}.json"
        alert_file.write_text(json.dumps({
            "type": "message",
            "chatJid": main_jid,
            "text": message,
        }))
        log(f"Telegram alert sent via IPC: {message[:100]}...")
    except Exception as e:
        log(f"Failed to send Telegram alert: {e}")


def is_auth_error(stdout: str, stderr: str) -> bool:
    """Detect authentication failures in claude -p output."""
    combined = (stdout + stderr).lower()
    return any(pattern.lower() in combined for pattern in AUTH_ERROR_PATTERNS)


def is_outage_error(stdout: str, stderr: str) -> bool:
    """Detect Anthropic API outage (distinct from auth failure)."""
    combined = (stdout + stderr).lower()
    return any(pattern in combined for pattern in OUTAGE_ERROR_PATTERNS)


def is_api_healthy() -> bool:
    """Check if Anthropic API is reachable. Any HTTP response = healthy.
    Only network-level failures (timeout, connection refused) = unhealthy."""
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            method="GET",
            headers={"anthropic-version": "2023-06-01"},
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except urllib.error.HTTPError:
        # HTTP error (401, 405, etc.) means the API is reachable
        return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def enter_outage_mode() -> None:
    """Enter outage mode — skip task processing until API recovers."""
    global outage_mode, outage_started_at, outage_alert_sent, health_check_attempt
    if outage_mode:
        return
    outage_mode = True
    outage_started_at = time.time()
    health_check_attempt = 0
    log("Entering outage mode — tasks will be held until API recovers")

    if not outage_alert_sent:
        outage_alert_sent = True
        send_telegram_alert(
            "*Host-Executor: API Outage Detected*\n\n"
            "Claude API is unreachable. Pending tasks will be held and "
            "retried automatically when the outage ends.\n\n"
            "No action needed unless this persists for hours."
        )


def exit_outage_mode() -> None:
    """Exit outage mode — API is back, resume processing."""
    global outage_mode, outage_alert_sent, health_check_attempt
    downtime_min = round((time.time() - outage_started_at) / 60)
    outage_mode = False
    outage_alert_sent = False
    health_check_attempt = 0
    log(f"Exiting outage mode — API recovered after ~{downtime_min} minutes")
    send_telegram_alert(
        f"*Host-Executor: API Recovered*\n\n"
        f"Auto-recovered after ~{downtime_min} minute(s). "
        f"Resuming task processing."
    )


def log_audit(entity: str, event: dict) -> None:
    """Append an audit event to the entity's daily audit log."""
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entity_dir = AUDIT_DIR / entity
        entity_dir.mkdir(parents=True, exist_ok=True)
        audit_file = entity_dir / f"{today}.jsonl"
        with open(audit_file, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        log(f"Audit log error: {e}")


def get_commits_since(project_dir: str, before_hash: str) -> list[str]:
    """Get commit hashes made since a given hash."""
    try:
        result = subprocess.run(
            ["git", "log", f"{before_hash}..HEAD", "--format=%h", "--reverse"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split("\n")
    except Exception:
        pass
    return []


def get_head_hash(project_dir: str) -> str:
    """Get current HEAD commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def auto_push(project_dir: str, entity: str) -> bool:
    """Push commits to origin. Returns True on success."""
    try:
        result = subprocess.run(
            ["git", "push", "origin", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log(f"Auto-push success: {project_dir}")
            return True
        else:
            log(f"Auto-push failed: {result.stderr.strip()}")
            log_audit(entity, {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "host_executor_push_failed",
                "project_dir": project_dir,
                "error": result.stderr.strip()[:500],
            })
            return False
    except Exception as e:
        log(f"Auto-push error: {e}")
        return False


def process_task(task_path: Path) -> None:
    """Process a single task request."""
    task_id = None
    entity = "unknown"

    try:
        task = json.loads(task_path.read_text())
        task_id = task.get("task_id", task_path.stem)
        entity = task.get("entity", "unknown")
        project_dir = task.get("project_dir", "")
        prompt = task.get("prompt", "")
        tier = task.get("tier", 2)
        model = task.get("model", "sonnet")
        callback_group = task.get("callback_group", "")

        log(f"Processing task {task_id} | entity={entity} tier={tier} model={model}")
        log(f"  project: {project_dir}")
        log(f"  prompt: {prompt[:100]}...")

        # Tier validation
        if tier >= 4:
            write_result(task_id, entity, "rejected", 1,
                         "Tier 4 tasks are CEO-only. Cannot execute autonomously.",
                         [], False)
            task_path.unlink()
            return

        # Validate project directory exists
        if not project_dir or not os.path.isdir(project_dir):
            write_result(task_id, entity, "error", 1,
                         f"Project directory not found: {project_dir}",
                         [], False)
            task_path.unlink()
            return

        # Record HEAD before execution for commit tracking
        head_before = get_head_hash(project_dir)

        # Build claude command
        cmd = ["claude", "-p", "--model", model]

        # Tier 1: read-only (no code modifications)
        if tier == 1:
            cmd.extend(["--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch"])

        # Run claude -p with the prompt on stdin
        start_time = time.time()
        result = subprocess.run(
            cmd,
            input=prompt,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT,
            env={**os.environ, "CLAUDE_CODE_ENTRY_POINT": "host-executor"},
        )
        duration_ms = int((time.time() - start_time) * 1000)

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        exit_code = result.returncode

        # Detect outage errors — hold task for retry, don't delete
        if is_outage_error(stdout, stderr):
            enter_outage_mode()
            log(f"Task {task_id} hit outage — holding in pending for retry")
            # DON'T delete the task file — it stays in pending for retry
            return

        # Detect auth failure — alert CEO immediately, don't silently fail
        if is_auth_error(stdout, stderr):
            # First check if this is actually an outage masquerading as auth error
            if not is_api_healthy():
                enter_outage_mode()
                log(f"Task {task_id} auth error but API unreachable — treating as outage, holding for retry")
                return

            auth_msg = (
                "*Host-Executor Auth Failure*\n\n"
                f"Task `{task_id}` for {entity} failed due to expired authentication.\n\n"
                "Run on your laptop:\n"
                "`scp ~/.claude/.credentials.json root@5.78.190.56:/home/atlas/.claude/.credentials.json`\n\n"
                "Or SSH and run:\n"
                "`/home/atlas/scripts/refresh-claude-auth.sh`"
            )
            send_telegram_alert(auth_msg)
            write_result(task_id, entity, "error", exit_code,
                         "Authentication expired. CEO alerted on Telegram.",
                         [], False)
            task_path.unlink()
            log(f"Task {task_id} failed: auth expired. CEO alerted.")
            return

        # Truncate output for result summary
        result_summary = stdout[:MAX_OUTPUT_SIZE]
        if len(stdout) > MAX_OUTPUT_SIZE:
            result_summary += f"\n... (truncated, full output: {len(stdout)} chars)"

        # Save full output
        full_output_path = OUTPUTS_DIR / f"{task_id}.txt"
        full_output_path.write_text(stdout)

        # Check for new commits
        new_commits = get_commits_since(project_dir, head_before) if head_before else []
        pushed = False

        # Auto-push if there are new commits
        if new_commits:
            pushed = auto_push(project_dir, entity)

        status = "success" if exit_code == 0 else "error"

        write_result(task_id, entity, status, exit_code, result_summary,
                     new_commits, pushed, str(full_output_path),
                     duration_ms, callback_group, prompt)

        # Audit log
        log_audit(entity, {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action": "host_executor_task",
            "task_id": task_id,
            "tier": tier,
            "model": model,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "commits": new_commits,
            "pushed": pushed,
        })

        log(f"Task {task_id} completed: {status} in {duration_ms}ms "
            f"| commits={len(new_commits)} pushed={pushed}")

        if stderr:
            log(f"  stderr: {stderr[:200]}")

    except subprocess.TimeoutExpired:
        log(f"Task {task_id} timed out after {TASK_TIMEOUT}s")
        write_result(task_id or "unknown", entity, "error", 1,
                     f"Task timed out after {TASK_TIMEOUT} seconds", [], False)
    except json.JSONDecodeError as e:
        log(f"Invalid task JSON in {task_path}: {e}")
    except Exception as e:
        log(f"Task {task_id} error: {e}")
        write_result(task_id or "unknown", entity, "error", 1,
                     f"Host-executor error: {e}", [], False)
    finally:
        # Remove pending task file — UNLESS in outage mode (task held for retry)
        if not outage_mode:
            try:
                if task_path.exists():
                    task_path.unlink()
            except Exception:
                pass


def write_result(
    task_id: str,
    entity: str,
    status: str,
    exit_code: int,
    result_summary: str,
    commits: list[str],
    pushed: bool,
    full_output_path: str = "",
    duration_ms: int = 0,
    callback_group: str = "",
    prompt: str = "",
) -> None:
    """Write task result to completed/ directory."""
    COMPLETED_DIR.mkdir(parents=True, exist_ok=True)

    result = {
        "task_id": task_id,
        "entity": entity,
        "status": status,
        "exit_code": exit_code,
        "prompt": prompt[:500] if prompt else "",
        "result_summary": result_summary,
        "full_output_path": full_output_path,
        "commits": commits,
        "pushed": pushed,
        "duration_ms": duration_ms,
        "callback_group": callback_group,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }

    result_path = COMPLETED_DIR / f"{task_id}.json"
    result_path.write_text(json.dumps(result, indent=2))
    log(f"Result written: {result_path}")


# --- Escalation file watcher (structural backup) ---
# Tracks which escalation files we've already alerted on.
# If the IPC alert from the container worked, the CEO already knows.
# This catches any escalation the container forgot to notify about.

SHARED_DIR = ATLAS_DIR / "shared"
ESCALATION_SEEN_FILE = ATLAS_DIR / "state" / "escalations-seen.json"


def load_seen_escalations() -> set[str]:
    """Load set of escalation file paths we've already alerted on."""
    try:
        if ESCALATION_SEEN_FILE.exists():
            return set(json.loads(ESCALATION_SEEN_FILE.read_text()))
    except Exception:
        pass
    return set()


def save_seen_escalations(seen: set[str]) -> None:
    """Persist seen escalation set."""
    try:
        ESCALATION_SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        ESCALATION_SEEN_FILE.write_text(json.dumps(sorted(seen)))
    except Exception:
        pass


def check_escalations() -> None:
    """Scan all department escalation directories for new files. Alert CEO on unseen ones."""
    if not SHARED_DIR.exists():
        return

    seen = load_seen_escalations()
    new_found = False

    for dept_dir in sorted(SHARED_DIR.iterdir()):
        if not dept_dir.is_dir():
            continue
        dept = dept_dir.name
        esc_dir = dept_dir / "escalations"
        if not esc_dir.exists():
            continue

        for esc_file in sorted(esc_dir.glob("*.md")):
            file_key = str(esc_file)
            if file_key in seen:
                continue

            # New escalation — read first few lines for summary
            try:
                content = esc_file.read_text(encoding="utf-8")
                # Extract title from first heading or first line
                title = "Unknown"
                for line in content.split("\n"):
                    line = line.strip()
                    if line.startswith("# "):
                        title = line[2:].strip()
                        break
                    elif line and title == "Unknown":
                        title = line[:80]
                        break

                summary = content[:200].replace("\n", " ").strip()

                alert_msg = (
                    f"*Staff Escalation — {dept}*\n\n"
                    f"{title}\n\n"
                    f"{summary}{'...' if len(content) > 200 else ''}\n\n"
                    f"File: `shared/{dept}/escalations/{esc_file.name}`"
                )
                send_telegram_alert(alert_msg)
                log(f"Escalation alert sent: {dept}/{esc_file.name}")

            except Exception as e:
                log(f"Error reading escalation {esc_file}: {e}")

            seen.add(file_key)
            new_found = True

    if new_found:
        save_seen_escalations(seen)


def main() -> None:
    global health_check_attempt
    log("Atlas Host-Executor starting")
    log(f"  Watching: {PENDING_DIR}")
    log(f"  Output:   {COMPLETED_DIR}")
    log(f"  Escalations: {SHARED_DIR}/*/escalations/")
    log(f"  Timeout:  {TASK_TIMEOUT}s per task")

    # Start quality check HTTP server (used by container response interceptor)
    try:
        start_quality_check_server()
    except Exception as e:
        log(f"WARNING: Quality check server failed to start: {e}")

    # Ensure directories exist
    for d in [PENDING_DIR, COMPLETED_DIR, OUTPUTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    # Seed seen escalations with existing files (don't alert on old ones at startup)
    seen = load_seen_escalations()
    if not seen and SHARED_DIR.exists():
        for esc_file in SHARED_DIR.glob("*/escalations/*.md"):
            seen.add(str(esc_file))
        if seen:
            save_seen_escalations(seen)
            log(f"Seeded {len(seen)} existing escalation(s) as seen")

    poll_count = 0
    last_health_check = 0.0

    while True:
        try:
            # --- Outage mode: health check with backoff, skip task processing ---
            if outage_mode:
                backoff_delay = HEALTH_CHECK_BACKOFF[
                    min(health_check_attempt, len(HEALTH_CHECK_BACKOFF) - 1)
                ]
                if time.time() - last_health_check >= backoff_delay:
                    last_health_check = time.time()
                    if is_api_healthy():
                        exit_outage_mode()
                        # Fall through to process pending tasks immediately
                    else:
                        health_check_attempt += 1
                        log(f"API still down — next health check in {backoff_delay}s "
                            f"(attempt {health_check_attempt})")
                        time.sleep(POLL_INTERVAL)
                        continue
                else:
                    time.sleep(POLL_INTERVAL)
                    continue

            # --- Normal mode: process pending tasks ---
            pending = sorted(PENDING_DIR.glob("*.json"))

            for task_path in pending:
                # If a task triggered outage mode, stop processing remaining tasks
                if outage_mode:
                    break
                process_task(task_path)

            # Check escalations every 6th poll (~30 seconds)
            poll_count += 1
            if poll_count % 6 == 0:
                check_escalations()

        except Exception as e:
            log(f"Poll error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
