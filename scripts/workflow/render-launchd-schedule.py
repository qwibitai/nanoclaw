#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import subprocess
from pathlib import Path


DEFAULT_LABELS = [
    "com.nanoclaw.platform-loop",
    "com.nanoclaw.pr-guardian",
    "com.nanoclaw.reliability-loop",
    "com.nanoclaw.nightly-improvement",
    "com.nanoclaw.morning-codex-prep",
]


def run_launchctl_print(label: str) -> str | None:
    uid = os.getuid()
    target = f"gui/{uid}/{label}"
    result = subprocess.run(
        ["launchctl", "print", target],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def extract_scalar(text: str, name: str) -> str | None:
    pattern = rf"^\s*{re.escape(name)} = (.+)$"
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1).strip() if match else None


def extract_block(text: str, block_name: str) -> list[str]:
    lines = text.splitlines()
    capture = False
    depth = 0
    collected: list[str] = []
    header = f"{block_name} = {{"
    for line in lines:
        stripped = line.strip()
        if not capture and stripped == header:
            capture = True
            depth = 1
            continue
        if not capture:
            continue
        depth += line.count("{")
        depth -= line.count("}")
        if depth <= 0:
            break
        collected.append(line.rstrip())
    return collected


def extract_arguments(text: str) -> list[str]:
    args = []
    for line in extract_block(text, "arguments"):
        stripped = line.strip()
        if not stripped or stripped == "}":
            continue
        args.append(stripped)
    return args


def extract_triggers(text: str) -> list[dict[str, str]]:
    trigger_lines = extract_block(text, "event triggers")
    triggers: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    in_descriptor = False

    for raw_line in trigger_lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.endswith("=> {") and "descriptor" not in line:
            current = {}
            continue
        if line == "descriptor = {":
            in_descriptor = True
            continue
        if in_descriptor:
            if line == "}":
                if current:
                    triggers.append(current)
                current = None
                in_descriptor = False
                continue
            match = re.match(r'"([^"]+)" => (.+)', line)
            if match and current is not None:
                current[match.group(1)] = match.group(2).strip()
    return triggers


def extract_calendar_watching(text: str) -> bool:
    channels = extract_block(text, "event channels")
    in_calendar = False
    for raw_line in channels:
        line = raw_line.strip()
        if line.startswith('"com.apple.launchd.calendarinterval" = {'):
            in_calendar = True
            continue
        if in_calendar and line == "}":
            in_calendar = False
            continue
        if in_calendar and line == "watching = 1":
            return True
    return False


def schedule_string(trigger: dict[str, str]) -> str:
    ordered_keys = ["Weekday", "Day", "Hour", "Minute", "Month"]
    parts = []
    for key in ordered_keys:
        if key in trigger:
            parts.append(f"{key}={trigger[key]}")
    for key in sorted(k for k in trigger.keys() if k not in ordered_keys):
        parts.append(f"{key}={trigger[key]}")
    return ", ".join(parts)


def code(text: str | None) -> str:
    if not text:
        return "`-`"
    safe = text.replace("`", "\\`")
    return f"`{safe}`"


def render_job(label: str, text: str | None) -> tuple[dict[str, str], str]:
    if text is None:
        summary = {
            "label": label,
            "loaded": "no",
            "armed": "no",
            "state": "unloaded",
            "schedule": "-",
            "command": "-",
        }
        details = "\n".join(
            [
                f"### `{label}`",
                "",
                "- Loaded: `no`",
                "- Armed: `no`",
                "- State: `unloaded`",
                "",
            ]
        )
        return summary, details

    state = extract_scalar(text, "state") or "unknown"
    active_count = extract_scalar(text, "active count") or "?"
    runs = extract_scalar(text, "runs") or "?"
    last_exit = extract_scalar(text, "last exit code") or "?"
    plist_path = extract_scalar(text, "path") or "-"
    stdout_path = extract_scalar(text, "stdout path") or "-"
    stderr_path = extract_scalar(text, "stderr path") or "-"
    arguments = extract_arguments(text)
    command = " ".join(arguments) if arguments else "-"
    triggers = extract_triggers(text)
    armed = "yes" if extract_calendar_watching(text) else "no"
    schedule = "; ".join(schedule_string(trigger) for trigger in triggers) if triggers else "-"

    summary = {
        "label": label,
        "loaded": "yes",
        "armed": armed,
        "state": state,
        "schedule": schedule,
        "command": command,
    }

    details_lines = [
        f"### `{label}`",
        "",
        f"- Loaded: `yes`",
        f"- Armed: `{armed}`",
        f"- State: {code(state)}",
        f"- Active Count: {code(active_count)}",
        f"- Runs: {code(runs)}",
        f"- Last Exit Code: {code(last_exit)}",
        f"- Installed Plist: {code(plist_path)}",
        f"- Command: {code(command)}",
        f"- Stdout: {code(stdout_path)}",
        f"- Stderr: {code(stderr_path)}",
        "- Calendar Triggers:",
    ]

    if triggers:
        for trigger in triggers:
            details_lines.append(f"  - {code(schedule_string(trigger))}")
    else:
        details_lines.append("  - `none`")

    details_lines.append("")
    return summary, "\n".join(details_lines)


def build_markdown(summaries: list[dict[str, str]], details: list[str]) -> str:
    timestamp = dt.datetime.now().astimezone()
    generated = timestamp.strftime("%Y-%m-%d %H:%M:%S %Z")
    lines = [
        "# Launchd Schedule",
        "",
        "<!-- Generated by scripts/workflow/render-launchd-schedule.py -->",
        "",
        f"Generated from `launchctl print` at `{generated}`.",
        "",
        "Armed means the loaded job is actively watching `com.apple.launchd.calendarinterval`.",
        "",
        "| Label | Loaded | Armed | State | Schedule | Command |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in summaries:
        lines.append(
            f"| `{item['label']}` | `{item['loaded']}` | `{item['armed']}` | "
            f"`{item['state']}` | `{item['schedule']}` | `{item['command']}` |"
        )
    lines.append("")
    lines.extend(details)
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render launchd schedule status into markdown.")
    parser.add_argument(
        "--output",
        default=".claude/schedule/launchd-jobs.md",
        help="Output markdown path",
    )
    parser.add_argument(
        "--label",
        action="append",
        dest="labels",
        help="Launchd label to inspect (repeatable). Defaults to NanoClaw scheduled jobs.",
    )
    args = parser.parse_args()

    labels = args.labels or DEFAULT_LABELS
    summaries = []
    details = []
    for label in labels:
        text = run_launchctl_print(label)
        summary, detail = render_job(label, text)
        summaries.append(summary)
        details.append(detail)

    repo_root = Path(__file__).resolve().parents[2]
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = repo_root / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(build_markdown(summaries, details), encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
