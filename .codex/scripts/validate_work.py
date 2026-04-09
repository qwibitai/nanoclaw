#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Any

from factory_gates import evaluate_factory_gates, report_lines
from factory_lib import dump_json, factory_dir, now_iso, repo_root


def run_script(root: Path, script: str, *extra_args: str) -> dict[str, Any]:
    cmd = [sys.executable, str(root / ".codex" / "scripts" / script), *extra_args]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    return {
        "command": " ".join(cmd),
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run deterministic validation sequence and enforce factory gates.",
    )
    parser.add_argument("--skip-verify", action="store_true", help="Skip verify.py execution.")
    parser.add_argument(
        "--allow-missing-run",
        action="store_true",
        help="Do not fail when .factory/run.json is missing (template/scaffold mode).",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate gates but do not mutate run state to pr-ready.",
    )
    parser.add_argument(
        "--report-path",
        help="Write JSON report to this path. Defaults to .factory/validation-report.json",
    )
    args = parser.parse_args()

    root = repo_root()
    report_path = Path(args.report_path) if args.report_path else factory_dir(root) / "validation-report.json"
    if not report_path.is_absolute():
        report_path = root / report_path
    summary: dict[str, Any] = {
        "started_at": now_iso(),
        "ok": True,
        "steps": {},
    }

    if args.skip_verify:
        summary["steps"]["verify"] = {"skipped": True}
    else:
        verify_step = run_script(root, "verify.py")
        summary["steps"]["verify"] = verify_step
        if verify_step["exit_code"] != 0:
            summary["ok"] = False

    gates = evaluate_factory_gates(root, allow_missing_run=args.allow_missing_run)
    summary["steps"]["gates"] = gates
    if not gates["ok"]:
        summary["ok"] = False

    if gates.get("mode") == "no-active-run":
        summary["steps"]["pr_ready"] = {"skipped": True, "reason": "no active run"}
    elif summary["ok"] and args.check_only:
        summary["steps"]["pr_ready"] = {"skipped": True, "reason": "check-only"}
    elif summary["ok"]:
        pr_ready_step = run_script(root, "pr_ready.py")
        summary["steps"]["pr_ready"] = pr_ready_step
        if pr_ready_step["exit_code"] != 0:
            summary["ok"] = False

    summary["completed_at"] = now_iso()
    dump_json(report_path, summary)

    if summary["ok"]:
        print("Validation harness passed.")
        return 0

    print("Validation harness failed.")
    verify_step = summary["steps"].get("verify", {})
    if isinstance(verify_step, dict) and verify_step.get("exit_code") not in (None, 0):
        print("- Deterministic verify failed. See .factory/verify.json and command output.")

    for line in report_lines(gates):
        print(line)

    pr_ready_step = summary["steps"].get("pr_ready", {})
    if isinstance(pr_ready_step, dict) and pr_ready_step.get("exit_code") not in (None, 0):
        print("- pr_ready gate failed. Run `python3 .codex/scripts/pr_ready.py` after fixing blockers.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
