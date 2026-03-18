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
from datetime import datetime, timezone
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

        # Detect auth failure — alert CEO immediately, don't silently fail
        if is_auth_error(stdout, stderr):
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
                     duration_ms, callback_group)

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
        # Remove pending task file
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
) -> None:
    """Write task result to completed/ directory."""
    COMPLETED_DIR.mkdir(parents=True, exist_ok=True)

    result = {
        "task_id": task_id,
        "entity": entity,
        "status": status,
        "exit_code": exit_code,
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


def main() -> None:
    log("Atlas Host-Executor starting")
    log(f"  Watching: {PENDING_DIR}")
    log(f"  Output:   {COMPLETED_DIR}")
    log(f"  Timeout:  {TASK_TIMEOUT}s per task")

    # Ensure directories exist
    for d in [PENDING_DIR, COMPLETED_DIR, OUTPUTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    while True:
        try:
            # List pending tasks (sorted by name for deterministic order)
            pending = sorted(PENDING_DIR.glob("*.json"))

            for task_path in pending:
                process_task(task_path)

        except Exception as e:
            log(f"Poll error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
