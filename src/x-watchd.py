#!/usr/bin/env python3
"""
x-watchd: Deterministic health daemon for X

Replaces NanoClaw's LLM-based scheduled health checks with a host-level
daemon that runs pure deterministic logic. LLM is never invoked.

Components:
  - Health monitor: SSH + docker ps + state classification + transition detection
  - Cross-channel context: query messages.db, write recent messages to CLAUDE.md
  - Event bus: JSONL append for state transitions (consumed by Layer 1)
  - Alert router: template-based Slack/Telegram alerts (no LLM)

Usage:
  python3 x-watchd.py [--check-interval 300] [--once] [--dry-run] [--verbose]
"""

import argparse
import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BOTS = {
    "db": {
        "ssh_target": "ubuntu@100.88.246.12",
        "container": "openclaw-openclaw-gateway-1",
        "label": "DB (Neuron)",
    },
    "nook": {
        "ssh_target": "rog",
        "container": "letta-server",
        "label": "Nook",
    },
}

HEALTHY_UPTIME_THRESHOLD = 300  # 5 minutes
SSH_CONNECT_TIMEOUT = 10
SSH_COMMAND_TIMEOUT = 30
CONSECUTIVE_FAILURES_BEFORE_ALERT = 2
COOLDOWN_SECONDS = 1800  # 30 min between alerts for same bot
CRASH_LOOP_THRESHOLD = 3

# Quiet hours: suppress info/warning between 23:00-07:00 Jerusalem
QUIET_START_HOUR = 23
QUIET_END_HOUR = 7

# Channel routing
SLACK_DM_CHANNEL = "D0AM0RZ7HB2"      # operator DM (critical/warning)
SLACK_GROUP_CHANNEL = "C0AJ4J9H9L1"   # group channel (info)

# Paths (relative to NANOCLAW_DIR)
NANOCLAW_DIR = Path(os.environ.get("NANOCLAW_DIR", os.path.expanduser("~/nanoclaw")))
DATA_DIR = NANOCLAW_DIR / "data" / "watcher"
HEALTH_STATE_FILE = DATA_DIR / "health-state.json"
EVENT_BUS_FILE = DATA_DIR / "events.jsonl"
MESSAGES_DB = NANOCLAW_DIR / "store" / "messages.db"
CROSS_CHANNEL_DIR = NANOCLAW_DIR / "data" / "extra" / "cross-channel"
CROSS_CHANNEL_FILE = CROSS_CHANNEL_DIR / "CLAUDE.md"
DEPENDENCIES_FILE = DATA_DIR / "dependencies.json"

# Telemetry
TELEMETRY_URL = os.environ.get("TELEMETRY_API_URL", "http://100.99.148.99:3100")
BOT_ID = os.environ.get("TELEMETRY_BOT_ID", "bfb9ea7c-79f5-4fd8-8fa7-f8350c62480b")

# Quota check (multi-subscription key monitoring)
QUOTA_CHECK_ENABLED = os.environ.get("QUOTA_CHECK_ENABLED", "true").lower() == "true"
QUOTA_WARNING_THRESHOLD = int(os.environ.get("QUOTA_WARNING_THRESHOLD", "80"))
KEYS_FILE = NANOCLAW_DIR / "config" / "keys.json"
ACTIVE_KEY_FILE = NANOCLAW_DIR / "data" / "active-key.json"
QUOTA_STATE_FILE = DATA_DIR / "quota-warnings.json"

log = logging.getLogger("x-watchd")

# ---------------------------------------------------------------------------
# Health state types
# ---------------------------------------------------------------------------

SEVERITY_RANK = {"healthy": 0, "degraded": 1, "down": 2, "unreachable": 3, "unknown": -1}


def load_env(path: Path):
    """Load .env file into os.environ (simple key=value, no quotes handling)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


# ---------------------------------------------------------------------------
# SSH + Docker status
# ---------------------------------------------------------------------------

def ssh_exec(target: str, command: str) -> tuple[bool, str]:
    """Execute command via SSH. Returns (success, stdout_or_error)."""
    ssh_args = [
        "ssh",
        "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        target,
        command,
    ]
    try:
        result = subprocess.run(
            ssh_args,
            capture_output=True,
            text=True,
            timeout=SSH_COMMAND_TIMEOUT,
        )
        if result.returncode != 0:
            return False, result.stderr.strip() or f"exit code {result.returncode}"
        return True, result.stdout.strip()
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, str(e)


def parse_uptime(running_for: str) -> int:
    """Parse docker 'RunningFor' string to seconds."""
    s = running_for.lower().strip()
    if "about an hour" in s:
        return 3600
    if "about a minute" in s:
        return 60

    total = 0
    for match in re.finditer(r"(\d+)\s*(second|minute|hour|day|week|month)", s):
        val = int(match.group(1))
        unit = match.group(2)
        multipliers = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800, "month": 2592000}
        total += val * multipliers.get(unit, 0)
    return total or 0


def check_bot(bot_id: str, bot_cfg: dict) -> dict:
    """Check a single bot's container status via SSH."""
    target = bot_cfg["ssh_target"]
    container = bot_cfg["container"]
    cmd = f"docker ps -a --filter name={container} --format '{{{{.Status}}}}\\t{{{{.State}}}}\\t{{{{.RunningFor}}}}'"

    ok, output = ssh_exec(target, cmd)

    now = datetime.now(timezone.utc).isoformat()

    if not ok:
        return {"bot": bot_id, "state": "unknown", "uptime_seconds": None,
                "status_string": output, "ssh_ok": False, "checked_at": now}

    if not output.strip():
        return {"bot": bot_id, "state": "not_found", "uptime_seconds": None,
                "status_string": "container not found", "ssh_ok": True, "checked_at": now}

    parts = output.split("\t")
    status_str = parts[0] if len(parts) > 0 else ""
    state_str = parts[1].lower() if len(parts) > 1 else ""
    running_for = parts[2] if len(parts) > 2 else ""

    if state_str == "running":
        docker_state = "running"
    elif state_str == "restarting":
        docker_state = "restarting"
    else:
        docker_state = "stopped"

    uptime = parse_uptime(running_for) if docker_state == "running" else None

    return {"bot": bot_id, "state": docker_state, "uptime_seconds": uptime,
            "status_string": status_str, "ssh_ok": True, "checked_at": now}


def classify_health(status: dict) -> str:
    """Classify bot health from docker status."""
    if not status["ssh_ok"]:
        return "unreachable"
    s = status["state"]
    if s in ("not_found", "stopped"):
        return "down"
    if s == "unknown":
        return "unreachable"
    if s == "restarting":
        return "degraded"
    if s == "running":
        uptime = status.get("uptime_seconds") or 0
        return "healthy" if uptime >= HEALTHY_UPTIME_THRESHOLD else "degraded"
    return "unknown"


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def load_health_state() -> dict:
    """Load previous health state from file."""
    if not HEALTH_STATE_FILE.exists():
        return {}
    try:
        return json.loads(HEALTH_STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        log.warning("Failed to read health state file, starting fresh")
        return {}


def save_health_state(state: dict):
    """Atomically write health state file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = HEALTH_STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.rename(HEALTH_STATE_FILE)


# ---------------------------------------------------------------------------
# Alert computation
# ---------------------------------------------------------------------------

def compute_alerts(bot_id: str, current_health: str, prev_bot_state: dict, now: str) -> list[dict]:
    """Compute alerts and recoveries for a bot."""
    alerts = []
    prev_state = prev_bot_state.get("state", "unknown")
    prev_severity = SEVERITY_RANK.get(prev_state, -1)
    curr_severity = SEVERITY_RANK.get(current_health, -1)
    consecutive = prev_bot_state.get("consecutiveFailures", 0)

    # State got worse
    if curr_severity > prev_severity and prev_state != "unknown":
        consecutive += 1
        if consecutive >= CONSECUTIVE_FAILURES_BEFORE_ALERT:
            last_alert = prev_bot_state.get("lastAlertAt")
            cooldown_ok = True
            if last_alert:
                try:
                    last_dt = datetime.fromisoformat(last_alert.replace("Z", "+00:00"))
                    cooldown_ok = (datetime.now(timezone.utc) - last_dt).total_seconds() >= COOLDOWN_SECONDS
                except (ValueError, TypeError):
                    pass
            if cooldown_ok:
                alerts.append({
                    "type": "state-transition",
                    "bot": bot_id,
                    "from": prev_state,
                    "to": current_health,
                    "severity": "critical" if current_health in ("down", "unreachable") else "warning",
                    "ts": now,
                })

    # Recovery
    if curr_severity < prev_severity and prev_state in ("down", "unreachable"):
        alerts.append({
            "type": "recovery",
            "bot": bot_id,
            "from": prev_state,
            "to": current_health,
            "severity": "info",
            "ts": now,
        })

    return alerts


def compute_fleet_status(bot_states: dict) -> str:
    """Compute fleet-wide status."""
    states = [b.get("state", "unknown") for k, b in bot_states.items() if k != "fleet"]
    if all(s == "healthy" for s in states):
        return "all-healthy"
    if all(s in ("down", "unreachable") for s in states):
        return "fleet-down"
    return "partial-degraded"


def check_correlation(bot_states: dict, alerts: list[dict]) -> list[dict]:
    """Check if multiple unreachable bots share infrastructure."""
    fleet_alerts = []
    unreachable = [a["bot"] for a in alerts if a["to"] in ("unreachable", "down")]
    if len(unreachable) < 2:
        return fleet_alerts

    # Load dependencies
    deps = {}
    if DEPENDENCIES_FILE.exists():
        try:
            deps = json.loads(DEPENDENCIES_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    for dep in deps.get("dependencies", []):
        dep_bots = dep.get("bots", [])
        if len(dep_bots) < 2:
            continue
        if all(b in unreachable for b in dep_bots):
            fleet_alerts.append({
                "type": "fleet-correlation",
                "dependency": dep["id"],
                "name": dep["name"],
                "affected_bots": dep_bots,
                "severity": "critical",
                "ts": datetime.now(timezone.utc).isoformat(),
            })

    return fleet_alerts


# ---------------------------------------------------------------------------
# Event bus
# ---------------------------------------------------------------------------

def write_event(event: dict):
    """Append event to JSONL event bus."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(EVENT_BUS_FILE, "a") as f:
        f.write(json.dumps(event) + "\n")
    log.info(f"Event: {event['type']} {event.get('bot', event.get('dependency', ''))}")


# ---------------------------------------------------------------------------
# Alert formatting (template-based, no LLM)
# ---------------------------------------------------------------------------

ALERT_TEMPLATES = {
    "state-transition": "{emoji} *{label}* is *{to}* (was {from_state})",
    "recovery": "{emoji} *{label}* recovered: {from_state} -> {to}",
    "fleet-correlation": "{emoji} *Fleet alert*: {name} — affected: {affected}",
    "crash-loop": "{emoji} *{label}* crash-looping ({count} consecutive degraded checks)",
}


def format_alert(event: dict) -> str:
    """Format an alert event into a message string."""
    severity = event.get("severity", "info")
    emoji_map = {"critical": "[CRITICAL]", "warning": "[WARNING]", "info": "[INFO]"}
    emoji = emoji_map.get(severity, "[INFO]")

    etype = event["type"]
    if etype == "state-transition":
        label = BOTS.get(event["bot"], {}).get("label", event["bot"])
        return ALERT_TEMPLATES[etype].format(
            emoji=emoji, label=label, to=event["to"], from_state=event["from"])
    elif etype == "recovery":
        label = BOTS.get(event["bot"], {}).get("label", event["bot"])
        return ALERT_TEMPLATES[etype].format(
            emoji=emoji, label=label, from_state=event["from"], to=event["to"])
    elif etype == "fleet-correlation":
        affected = ", ".join(event.get("affected_bots", []))
        return ALERT_TEMPLATES[etype].format(
            emoji=emoji, name=event["name"], affected=affected)
    elif etype == "crash-loop":
        label = BOTS.get(event["bot"], {}).get("label", event["bot"])
        return ALERT_TEMPLATES[etype].format(
            emoji=emoji, label=label, count=event.get("count", 0))
    return f"{emoji} {json.dumps(event)}"


def is_quiet_hours() -> bool:
    """Check if current time is in quiet hours (Jerusalem timezone)."""
    try:
        # Get Jerusalem time via offset (UTC+3 in summer, UTC+2 in winter)
        # Simple approach: just check UTC hour adjusted
        utc_now = datetime.now(timezone.utc)
        # Jerusalem is typically UTC+3 (IDT) April-October
        jerusalem_hour = (utc_now.hour + 3) % 24
        if QUIET_START_HOUR > QUIET_END_HOUR:
            return jerusalem_hour >= QUIET_START_HOUR or jerusalem_hour < QUIET_END_HOUR
        return QUIET_START_HOUR <= jerusalem_hour < QUIET_END_HOUR
    except Exception:
        return False


def route_alert(event: dict) -> str | None:
    """Determine which Slack channel to route an alert to. Returns channel ID or None."""
    severity = event.get("severity", "info")
    if is_quiet_hours() and severity in ("info", "warning"):
        log.info(f"Suppressing {severity} alert during quiet hours")
        return None
    if severity in ("critical", "warning"):
        return SLACK_DM_CHANNEL
    return SLACK_GROUP_CHANNEL


def send_slack(channel: str, text: str, dry_run: bool = False):
    """Send a message to Slack via Bot API."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        log.warning("SLACK_BOT_TOKEN not set, skipping Slack alert")
        return
    if dry_run:
        log.info(f"[DRY-RUN] Slack #{channel}: {text}")
        return

    data = json.dumps({"channel": channel, "text": text}).encode()
    req = Request(
        "https://slack.com/api/chat.postMessage",
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        resp = urlopen(req, timeout=10)
        body = json.loads(resp.read())
        if not body.get("ok"):
            log.warning(f"Slack API error: {body.get('error', 'unknown')}")
    except Exception as e:
        log.warning(f"Failed to send Slack message: {e}")


def send_telemetry_event(event_type: str, payload: dict, dry_run: bool = False):
    """Send a telemetry event to the UTI API."""
    if dry_run:
        log.info(f"[DRY-RUN] Telemetry: {event_type}")
        return

    token = os.environ.get("TELEMETRY_REGISTRATION_TOKEN", "")
    if not token:
        log.debug("TELEMETRY_REGISTRATION_TOKEN not set, skipping telemetry")
        return

    event = {
        "event_type": event_type,
        "bot_id": BOT_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": payload,
    }
    data = json.dumps(event).encode()
    req = Request(
        f"{TELEMETRY_URL}/api/ingest",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        urlopen(req, timeout=5)
    except Exception as e:
        log.debug(f"Telemetry event failed (non-critical): {e}")


# ---------------------------------------------------------------------------
# Cross-channel context builder
# ---------------------------------------------------------------------------

def update_cross_channel_context():
    """Query messages.db and write recent messages to cross-channel CLAUDE.md."""
    if not MESSAGES_DB.exists():
        log.debug("messages.db not found, skipping cross-channel update")
        return

    try:
        conn = sqlite3.connect(str(MESSAGES_DB), timeout=5)
        conn.row_factory = sqlite3.Row

        # Get recent messages (last 2 hours) grouped by channel
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        rows = conn.execute("""
            SELECT chat_jid, sender_name, content, timestamp, is_from_me
            FROM messages
            WHERE timestamp > ?
            ORDER BY chat_jid, timestamp
        """, (cutoff,)).fetchall()
        conn.close()

        if not rows:
            return

        # Group by channel
        channels: dict[str, list] = {}
        for row in rows:
            jid = row["chat_jid"]
            channels.setdefault(jid, []).append(row)

        # Format
        lines = [f"## Recent Messages (last 2h, updated {datetime.now(timezone.utc).strftime('%H:%M UTC')})\n"]
        for jid, msgs in channels.items():
            # Limit to last 20 per channel
            msgs = msgs[-20:]
            lines.append(f"### {jid}\n")
            for m in msgs:
                ts = m["timestamp"][:16].split("T")[1] if "T" in m["timestamp"] else m["timestamp"][:5]
                sender = "X" if m["is_from_me"] else (m["sender_name"] or "unknown")
                content = (m["content"] or "")[:200]
                lines.append(f"[{ts}] {sender}: {content}")
            lines.append("")

        CROSS_CHANNEL_DIR.mkdir(parents=True, exist_ok=True)
        content = "\n".join(lines)
        tmp = CROSS_CHANNEL_FILE.with_suffix(".tmp")
        tmp.write_text(content)
        tmp.rename(CROSS_CHANNEL_FILE)
        log.debug(f"Cross-channel context updated ({len(rows)} messages)")

    except Exception as e:
        log.warning(f"Cross-channel update failed: {e}")



# ---------------------------------------------------------------------------
# Quota check (multi-subscription key monitoring)
# ---------------------------------------------------------------------------

def run_quota_check(dry_run: bool = False):
    """Check per-key token usage and recommend key switch if threshold exceeded.

    Fully deterministic -- no LLM calls. Reads keys.json to detect multi-key
    mode, queries telemetry API for budget usage, and writes recommendation
    events to the JSONL event bus if usage exceeds threshold.
    """
    if not QUOTA_CHECK_ENABLED:
        log.debug("Quota check disabled via QUOTA_CHECK_ENABLED")
        return

    if not KEYS_FILE.exists():
        log.debug("keys.json not found, single-key mode -- skipping quota check")
        return

    # Load keys config
    try:
        keys_data = json.loads(KEYS_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"Failed to read keys.json: {e}")
        return

    if not isinstance(keys_data, list) or len(keys_data) < 2:
        log.debug("Less than 2 keys configured -- skipping quota check")
        return

    # Load active key
    active_label = None
    if ACTIVE_KEY_FILE.exists():
        try:
            active_data = json.loads(ACTIVE_KEY_FILE.read_text())
            active_label = active_data.get("label") or active_data.get("name")
        except (json.JSONDecodeError, OSError):
            pass

    # Load rate-limit state (last warning timestamp per key)
    quota_state = {}
    if QUOTA_STATE_FILE.exists():
        try:
            quota_state = json.loads(QUOTA_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # Query budget endpoint
    try:
        req = Request(
            f"{TELEMETRY_URL}/api/bots/{BOT_ID}/budget",
            headers={"Content-Type": "application/json"},
        )
        resp = urlopen(req, timeout=10)
        budget = json.loads(resp.read())
    except Exception as e:
        log.debug(f"Quota check: budget API query failed (non-critical): {e}")
        return

    pct = budget.get("pct")
    if pct is None:
        log.debug("Quota check: budget response missing pct field")
        return

    log.info(f"Quota check: budget usage {pct}% (threshold: {QUOTA_WARNING_THRESHOLD}%)")

    if pct <= QUOTA_WARNING_THRESHOLD:
        return

    # Determine which key to suggest switching to
    key_labels = [k.get("label") or k.get("name", f"key-{i}") for i, k in enumerate(keys_data)]
    current_key = active_label or key_labels[0]

    # Find next key that is not the current one
    other_keys = [k for k in key_labels if k != current_key]
    suggest = other_keys[0] if other_keys else None
    if not suggest:
        log.debug("Quota check: no alternative key to suggest")
        return

    # Rate limit: max 1 recommendation per key per hour
    last_warning_ts = quota_state.get(current_key)
    if last_warning_ts:
        try:
            last_dt = datetime.fromisoformat(last_warning_ts.replace("Z", "+00:00"))
            elapsed = (now - last_dt).total_seconds()
            if elapsed < 3600:
                log.debug(f"Quota check: rate-limited for key {current_key} ({int(3600 - elapsed)}s remaining)")
                return
        except (ValueError, TypeError):
            pass

    # Write recommendation event
    event = {
        "type": "quota.warning",
        "key": current_key,
        "pct": pct,
        "suggest_switch_to": suggest,
        "timestamp": now_iso,
    }
    write_event(event)
    log.info(f"Quota warning: key '{current_key}' at {pct}%, suggesting switch to '{suggest}'")

    # Update rate-limit state
    quota_state[current_key] = now_iso
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        tmp = QUOTA_STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(quota_state, indent=2))
        tmp.rename(QUOTA_STATE_FILE)
    except OSError as e:
        log.warning(f"Failed to save quota state: {e}")


# ---------------------------------------------------------------------------
# Main health check cycle
# ---------------------------------------------------------------------------

def run_health_check(dry_run: bool = False, verbose: bool = False) -> dict:
    """Run one health check cycle. Returns summary."""
    now = datetime.now(timezone.utc).isoformat()
    state = load_health_state()
    all_alerts = []

    for bot_id, bot_cfg in BOTS.items():
        # Check bot status via SSH
        status = check_bot(bot_id, bot_cfg)
        health = classify_health(status)
        log.info(f"{bot_cfg['label']}: {health} (docker: {status['state']}, ssh: {status['ssh_ok']})")

        # Get/create previous state
        prev = state.get(bot_id, {
            "state": "unknown", "previousState": "unknown",
            "lastStateChange": now, "lastCheckAt": now,
            "consecutiveFailures": 0, "lastAlertAt": None,
            "crashLoopCount": 0,
        })

        # Compute alerts
        alerts = compute_alerts(bot_id, health, prev, now)
        all_alerts.extend(alerts)

        # Crash-loop detection
        crash_count = prev.get("crashLoopCount", 0)
        if health == "degraded":
            crash_count += 1
            if crash_count >= CRASH_LOOP_THRESHOLD:
                all_alerts.append({
                    "type": "crash-loop", "bot": bot_id,
                    "count": crash_count, "severity": "warning", "ts": now,
                })
        else:
            crash_count = 0

        # Update consecutive failures
        consecutive = prev.get("consecutiveFailures", 0)
        if health in ("down", "unreachable", "degraded"):
            consecutive += 1
        else:
            consecutive = 0

        # Update state
        state_changed = health != prev.get("state")
        state[bot_id] = {
            "state": health,
            "previousState": prev.get("state", "unknown"),
            "lastStateChange": now if state_changed else prev.get("lastStateChange", now),
            "lastCheckAt": now,
            "consecutiveFailures": consecutive,
            "lastAlertAt": alerts[0]["ts"] if alerts else prev.get("lastAlertAt"),
            "crashLoopCount": crash_count,
            "autoFixAttempts": prev.get("autoFixAttempts", 0),
            "autoFixWindowStart": prev.get("autoFixWindowStart"),
            "lastCriticalAlertAt": prev.get("lastCriticalAlertAt"),
            "criticalAlertAcknowledged": prev.get("criticalAlertAcknowledged", False),
            "escalationCount": prev.get("escalationCount", 0),
            "lastEscalationAt": prev.get("lastEscalationAt"),
            "maintenance": prev.get("maintenance"),
        }
        if alerts and any(a["severity"] == "critical" for a in alerts):
            state[bot_id]["lastCriticalAlertAt"] = now
            state[bot_id]["criticalAlertAcknowledged"] = False

    # Fleet correlation
    fleet_alerts = check_correlation(state, all_alerts)
    all_alerts.extend(fleet_alerts)

    # Fleet status
    fleet_status = compute_fleet_status(state)
    state["fleet"] = {
        "status": fleet_status,
        "lastCorrelatedEvent": fleet_alerts[0]["ts"] if fleet_alerts else state.get("fleet", {}).get("lastCorrelatedEvent"),
        "lastUpdated": now,
    }

    # Save state
    save_health_state(state)

    # Process alerts
    for alert in all_alerts:
        write_event(alert)
        msg = format_alert(alert)
        channel = route_alert(alert)
        if channel:
            send_slack(channel, msg, dry_run=dry_run)

    # Quota check (multi-subscription key monitoring)
    try:
        run_quota_check(dry_run=dry_run)
    except Exception as e:
        log.error(f"Quota check failed: {e}", exc_info=verbose)

    # Emit telemetry heartbeat
    send_telemetry_event("watchd.health_check", {
        "fleet_status": fleet_status,
        "bots_checked": len(BOTS),
        "alerts_fired": len(all_alerts),
    }, dry_run=dry_run)

    return {
        "fleet_status": fleet_status,
        "alerts": len(all_alerts),
        "bots": {bid: state[bid]["state"] for bid in BOTS},
    }


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="x-watchd: Deterministic health daemon")
    parser.add_argument("--check-interval", type=int, default=300, help="Health check interval in seconds (default: 300)")
    parser.add_argument("--context-interval", type=int, default=600, help="Cross-channel context update interval (default: 600)")
    parser.add_argument("--once", action="store_true", help="Run one check cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="Don't send alerts or telemetry")
    parser.add_argument("--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    # Load .env
    load_env(NANOCLAW_DIR / ".env")

    log.info(f"x-watchd starting (check every {args.check_interval}s, context every {args.context_interval}s)")
    log.info(f"Monitoring: {', '.join(BOTS.keys())}")
    log.info(f"State file: {HEALTH_STATE_FILE}")
    log.info(f"Event bus: {EVENT_BUS_FILE}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.once:
        result = run_health_check(dry_run=args.dry_run, verbose=args.verbose)
        update_cross_channel_context()
        log.info(f"Result: {json.dumps(result)}")
        sys.exit(0)

    # Graceful shutdown
    running = True
    def handle_signal(sig, frame):
        nonlocal running
        log.info(f"Received signal {sig}, shutting down...")
        running = False
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    last_health = 0
    last_context = 0

    while running:
        now = time.monotonic()

        # Health check
        if now - last_health >= args.check_interval:
            try:
                result = run_health_check(dry_run=args.dry_run, verbose=args.verbose)
                log.info(f"Fleet: {result['fleet_status']} | Alerts: {result['alerts']} | {result['bots']}")
            except Exception as e:
                log.error(f"Health check failed: {e}", exc_info=args.verbose)
            last_health = now

        # Cross-channel context
        if now - last_context >= args.context_interval:
            try:
                update_cross_channel_context()
            except Exception as e:
                log.error(f"Context update failed: {e}", exc_info=args.verbose)
            last_context = now

        # Sleep in small increments for responsive shutdown
        for _ in range(10):
            if not running:
                break
            time.sleep(1)

    log.info("x-watchd stopped")


if __name__ == "__main__":
    main()
