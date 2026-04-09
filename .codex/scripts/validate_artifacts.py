#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from factory_gates import evaluate_factory_gates, report_lines
from factory_lib import dump_json, factory_dir, repo_root


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate factory artifacts and quality gates.")
    parser.add_argument(
        "--allow-missing-run",
        action="store_true",
        help="Do not fail when .factory/run.json is missing (template/scaffold mode).",
    )
    parser.add_argument(
        "--report-path",
        help="Write JSON report to this path. Defaults to .factory/validation-report.json",
    )
    args = parser.parse_args()

    root = repo_root()
    report = evaluate_factory_gates(root, allow_missing_run=args.allow_missing_run)
    report_path = Path(args.report_path) if args.report_path else factory_dir(root) / "validation-report.json"
    if not report_path.is_absolute():
        report_path = root / report_path
    dump_json(report_path, report)

    if report.get("mode") == "no-active-run":
        print("No active factory run found; artifact validation skipped.")
        return 0

    if report["ok"]:
        print("Factory artifacts valid.")
        for line in report_lines(report):
            if "[warning]" in line:
                print(line)
        return 0

    print("Factory artifacts invalid:")
    for line in report_lines(report):
        print(line)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
