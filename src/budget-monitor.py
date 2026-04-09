#!/usr/bin/env python3
"""
Budget monitor for X's Claude Code sessions.

Reads JSONL session files, sums token usage for today, checks against
configurable limits, writes budget-state.json, and optionally pushes
to telemetry API.

Designed to run as a cron job on XPS with zero pip dependencies.
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
import urllib.error
from datetime import datetime, timezone, date
from pathlib import Path

# ── Defaults ──────────────────────────────────────────────────────────

SESSIONS_DIR = Path("/home/thh3/nanoclaw/data/sessions")
STATE_FILE = Path("/home/thh3/nanoclaw/data/budget-state.json")

DAILY_TOKEN_LIMIT = 500_000
DAILY_SESSION_LIMIT = 50
DAILY_COST_LIMIT = 15.0
WARNING_PCT = 70
CRITICAL_PCT = 90

# ── Cost tables (per million tokens) ─────────────────────────────────

COST_TABLE = {
    "haiku": {
        "input": 0.80,
        "output": 4.00,
        "cache_read": 0.08,
    },
    "sonnet": {
        "input": 3.00,
        "output": 15.00,
        "cache_read": 0.30,
    },
}


def model_family(model: str) -> str:
    """Map a model id string to a cost-table key."""
    m = model.lower()
    if "haiku" in m:
        return "haiku"
    if "sonnet" in m:
        return "sonnet"
    if "opus" in m:
        return "sonnet"  # bill opus at sonnet rates (conservative)
    return "sonnet"  # unknown models default to higher cost


def estimate_cost(input_tokens: int, output_tokens: int,
                  cache_read_tokens: int, family: str) -> float:
    """Estimate dollar cost for a set of tokens."""
    rates = COST_TABLE.get(family, COST_TABLE["sonnet"])
    return (
        input_tokens * rates["input"] / 1_000_000
        + output_tokens * rates["output"] / 1_000_000
        + cache_read_tokens * rates["cache_read"] / 1_000_000
    )


# ── JSONL scanning ───────────────────────────────────────────────────

def find_today_jsonl_files(sessions_dir: Path, today: date) -> list[Path]:
    """Return JSONL files whose mtime falls on *today*."""
    results = []
    if not sessions_dir.exists():
        return results
    for p in sessions_dir.rglob("*.jsonl"):
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime)
            if mtime.date() == today:
                results.append(p)
        except OSError:
            continue
    return results


def scan_jsonl(path: Path, today: date, verbose: bool = False):
    """
    Stream a JSONL file and yield per-call usage dicts for today's
    assistant messages.

    Yields dicts:
      { model, input_tokens, output_tokens, cache_read_input_tokens }
    """
    today_str = str(today)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    if verbose:
                        print(f"  WARN: corrupt JSON at {path}:{lineno}")
                    continue

                if rec.get("type") != "assistant":
                    continue

                msg = rec.get("message") or {}
                usage = msg.get("usage")
                if not usage:
                    continue

                # Timestamp filter: only count today's calls
                ts = rec.get("timestamp") or msg.get("timestamp") or ""
                if ts and not ts.startswith(today_str):
                    continue

                yield {
                    "model": msg.get("model", "unknown"),
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                }
    except OSError as exc:
        if verbose:
            print(f"  WARN: cannot read {path}: {exc}")


# ── Main logic ───────────────────────────────────────────────────────

def collect_usage(sessions_dir: Path, today: date, verbose: bool = False):
    """Scan all today's JSONL files and return aggregated usage."""
    files = find_today_jsonl_files(sessions_dir, today)
    if verbose:
        print(f"Found {len(files)} JSONL file(s) modified today")

    by_model: dict[str, dict] = {}
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_calls = 0
    session_count = len(files)

    for fp in files:
        if verbose:
            print(f"  Scanning {fp}")
        for usage in scan_jsonl(fp, today, verbose=verbose):
            model = usage["model"]
            inp = usage["input_tokens"]
            out = usage["output_tokens"]
            cr = usage["cache_read_input_tokens"]

            total_input += inp
            total_output += out
            total_cache_read += cr
            total_calls += 1

            if model not in by_model:
                by_model[model] = {
                    "calls": 0, "input": 0, "output": 0,
                    "cache_read": 0, "cost": 0.0,
                }
            entry = by_model[model]
            entry["calls"] += 1
            entry["input"] += inp
            entry["output"] += out
            entry["cache_read"] += cr

    # Calculate per-model costs
    for model, entry in by_model.items():
        fam = model_family(model)
        entry["cost"] = round(estimate_cost(
            entry["input"], entry["output"], entry["cache_read"], fam
        ), 4)

    total_cost = sum(e["cost"] for e in by_model.values())

    return {
        "total_input": total_input,
        "total_output": total_output,
        "total_cache_read": total_cache_read,
        "total_calls": total_calls,
        "session_count": session_count,
        "total_cost": round(total_cost, 4),
        "by_model": by_model,
    }


def evaluate_budget(usage: dict, token_limit: int, session_limit: int,
                    cost_limit: float, warning_pct: int, critical_pct: int):
    """Return (level, pct, hard_stop) based on usage vs limits."""
    used_tokens = usage["total_input"] + usage["total_output"]
    token_pct = (used_tokens / token_limit * 100) if token_limit > 0 else 0
    cost_pct = (usage["total_cost"] / cost_limit * 100) if cost_limit > 0 else 0
    session_pct = (usage["session_count"] / session_limit * 100) if session_limit > 0 else 0

    pct = max(token_pct, cost_pct, session_pct)

    if pct >= 100:
        return "hard_stop", round(pct, 1), True
    elif pct >= critical_pct:
        return "critical", round(pct, 1), False
    elif pct >= warning_pct:
        return "warning", round(pct, 1), False
    else:
        return "ok", round(pct, 1), False


def build_state(usage: dict, level: str, pct: float, hard_stop: bool,
                token_limit: int, session_limit: int, cost_limit: float,
                today: date):
    """Build the budget-state dict."""
    used_tokens = usage["total_input"] + usage["total_output"]
    return {
        "hard_stop": hard_stop,
        "level": level,
        "pct": pct,
        "used_tokens": used_tokens,
        "limit_tokens": token_limit,
        "used_sessions": usage["session_count"],
        "limit_sessions": session_limit,
        "estimated_cost": round(usage["total_cost"], 2),
        "cost_limit": cost_limit,
        "by_model": usage["by_model"],
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "day": str(today),
    }


def write_state_atomic(state: dict, path: Path):
    """Write state to a temp file then atomically rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp",
                               prefix="budget-state-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def push_to_telemetry(state: dict, api_url: str, verbose: bool = False):
    """POST budget status to the telemetry ingest endpoint."""
    payload = {
        "bot_name": "X",
        "event_type": "model.budget_status",
        "payload": state,
    }
    data = json.dumps(payload).encode("utf-8")
    url = api_url.rstrip("/") + "/api/ingest"
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if verbose:
                print(f"Telemetry push: {resp.status} {resp.reason}")
    except (urllib.error.URLError, OSError) as exc:
        print(f"WARN: telemetry push failed: {exc}", file=sys.stderr)


def format_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K"
    return str(n)


def print_alerts(state: dict):
    """Print alert lines to stdout based on budget level."""
    level = state["level"]
    pct = state["pct"]
    used = format_tokens(state["used_tokens"])
    limit = format_tokens(state["limit_tokens"])
    cost = state["estimated_cost"]

    if level == "hard_stop":
        print(f"HARD_STOP: BUDGET EXCEEDED ({pct}%) — X should be paused "
              f"({used}/{limit} tokens, ${cost:.2f} est.)")
    elif level == "critical":
        print(f"CRITICAL: Budget at {pct}% — approaching hard stop "
              f"({used}/{limit} tokens, ${cost:.2f} est.)")
    elif level == "warning":
        print(f"WARNING: Budget at {pct}% "
              f"({used}/{limit} tokens, ${cost:.2f} est.)")


def print_report(state: dict, usage: dict):
    """Print a detailed usage report."""
    print(f"\n=== X Budget Report — {state['day']} ===")
    print(f"Level:    {state['level'].upper()} ({state['pct']}%)")
    print(f"Tokens:   {format_tokens(state['used_tokens'])} / "
          f"{format_tokens(state['limit_tokens'])}")
    print(f"Sessions: {state['used_sessions']} / {state['limit_sessions']}")
    print(f"Cost:     ${state['estimated_cost']:.2f} / "
          f"${state['cost_limit']:.2f}")
    print(f"Calls:    {usage['total_calls']}")
    print()
    if state["by_model"]:
        print("By model:")
        for model, info in sorted(state["by_model"].items()):
            print(f"  {model}: {info['calls']} calls, "
                  f"{format_tokens(info['input'])} in / "
                  f"{format_tokens(info['output'])} out, "
                  f"${info['cost']:.4f}")
    print()


# ── CLI ──────────────────────────────────────────────────────────────

def parse_args(argv=None):
    p = argparse.ArgumentParser(description="X budget monitor")
    p.add_argument("--sessions-dir", type=Path, default=None,
                   help=f"Sessions directory (default: {SESSIONS_DIR})")
    p.add_argument("--state-file", type=Path, default=None,
                   help=f"Output state file (default: {STATE_FILE})")
    p.add_argument("--token-limit", type=int, default=None)
    p.add_argument("--session-limit", type=int, default=None)
    p.add_argument("--cost-limit", type=float, default=None)
    p.add_argument("--warning-pct", type=int, default=None)
    p.add_argument("--critical-pct", type=int, default=None)
    p.add_argument("--dry-run", action="store_true",
                   help="Print report without writing state file")
    p.add_argument("--verbose", "-v", action="store_true",
                   help="Detailed output")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    sessions_dir = args.sessions_dir or Path(
        os.environ.get("SESSIONS_DIR", str(SESSIONS_DIR)))
    state_file = args.state_file or Path(
        os.environ.get("STATE_FILE", str(STATE_FILE)))
    token_limit = args.token_limit or int(
        os.environ.get("DAILY_TOKEN_LIMIT", DAILY_TOKEN_LIMIT))
    session_limit = args.session_limit or int(
        os.environ.get("DAILY_SESSION_LIMIT", DAILY_SESSION_LIMIT))
    cost_limit = args.cost_limit or float(
        os.environ.get("DAILY_COST_LIMIT", DAILY_COST_LIMIT))
    warning_pct = args.warning_pct or int(
        os.environ.get("WARNING_PCT", WARNING_PCT))
    critical_pct = args.critical_pct or int(
        os.environ.get("CRITICAL_PCT", CRITICAL_PCT))

    today = date.today()
    telemetry_url = os.environ.get("TELEMETRY_API_URL", "")

    if args.verbose:
        print(f"Sessions dir: {sessions_dir}")
        print(f"State file:   {state_file}")
        print(f"Limits:       {token_limit} tokens, {session_limit} sessions, "
              f"${cost_limit}")
        print(f"Thresholds:   warn={warning_pct}%, critical={critical_pct}%")
        print(f"Today:        {today}")
        print()

    usage = collect_usage(sessions_dir, today, verbose=args.verbose)
    level, pct, hard_stop = evaluate_budget(
        usage, token_limit, session_limit, cost_limit,
        warning_pct, critical_pct,
    )
    state = build_state(
        usage, level, pct, hard_stop,
        token_limit, session_limit, cost_limit, today,
    )

    # Always print alerts
    print_alerts(state)

    if args.verbose or args.dry_run:
        print_report(state, usage)

    if args.dry_run:
        print("(dry-run — state file not written)")
    else:
        write_state_atomic(state, state_file)
        if args.verbose:
            print(f"State written to {state_file}")

    if telemetry_url and not args.dry_run:
        push_to_telemetry(state, telemetry_url, verbose=args.verbose)

    # Exit code: 2 for hard_stop, 1 for critical, 0 otherwise
    if hard_stop:
        return 2
    elif level == "critical":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
