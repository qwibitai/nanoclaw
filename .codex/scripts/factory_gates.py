#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any

from factory_lib import (
    decomposition_state_path,
    load_json,
    now_iso,
    review_dir,
    run_state_path,
    tests_state_path,
    verify_state_path,
)

ALLOWED_TEST_STATUS = {"passed", "failed", "partial"}
ALLOWED_RECOMMENDATION = {
    "approve",
    "approve-with-caveats",
    "changes-required",
}
REVIEW_ASPECTS = ("quality", "performance", "security")


def _append_issue(report: dict[str, Any], code: str, message: str, path: str | None = None) -> None:
    issue = {"code": code, "message": message}
    if path:
        issue["path"] = path
    report["issues"].append(issue)
    report["ok"] = False


def _append_warning(report: dict[str, Any], code: str, message: str, path: str | None = None) -> None:
    warning = {"code": code, "message": message}
    if path:
        warning["path"] = path
    report["warnings"].append(warning)


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(value)]


def _as_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _validate_test_entry(
    report: dict[str, Any],
    kind: str,
    entry: dict[str, Any],
) -> None:
    path = ".factory/tests.json"
    required_common = {"status", "summary", "blocking_findings", "reviewed_scope"}
    required_by_kind: dict[str, set[str]] = {
        "automated": {
            "tests_added_or_updated",
            "commands_run",
            "pass_fail_summary",
            "remaining_gaps",
        },
        "functional": {
            "score",
            "manual_validation_steps",
            "non_blocking_findings",
            "residual_risks",
            "recommendation",
        },
    }
    missing = [key for key in sorted(required_common | required_by_kind[kind]) if key not in entry]
    if missing:
        _append_issue(
            report,
            f"missing_{kind}_test_fields",
            f"{kind} test artifact missing required fields: {', '.join(missing)}",
            path,
        )
        return

    status = str(entry.get("status", "")).strip().lower()
    if status not in ALLOWED_TEST_STATUS:
        _append_issue(
            report,
            f"invalid_{kind}_status",
            f"{kind} testing status must be one of: passed, failed, partial.",
            path,
        )

    blockers = _as_list(entry.get("blocking_findings"))
    if blockers:
        _append_issue(
            report,
            f"{kind}_testing_blockers",
            f"{kind} testing must have no blocking findings.",
            path,
        )

    if status == "failed":
        _append_issue(
            report,
            f"{kind}_testing_failed",
            f"{kind} testing status is failed.",
            path,
        )

    if kind == "functional":
        score = _as_number(entry.get("score"))
        if score is None:
            _append_issue(
                report,
                "functional_missing_score",
                "functional testing must include a numeric score.",
                path,
            )
        elif score < 8:
            _append_issue(
                report,
                "functional_score_below_threshold",
                "functional testing score must be >= 8.",
                path,
            )

        recommendation = str(entry.get("recommendation", "")).strip().lower()
        if recommendation not in ALLOWED_RECOMMENDATION:
            _append_warning(
                report,
                "functional_recommendation_unexpected",
                "functional recommendation should be one of: approve, approve-with-caveats, changes-required.",
                path,
            )


def _validate_review_entry(
    report: dict[str, Any],
    aspect: str,
    entry: dict[str, Any],
) -> None:
    path = f".factory/reviews/{aspect}.json"
    required = {
        "score",
        "summary",
        "blocking_findings",
        "non_blocking_findings",
        "residual_risks",
        "recommendation",
        "reviewed_scope",
    }
    missing = [key for key in sorted(required) if key not in entry]
    if missing:
        _append_issue(
            report,
            f"missing_{aspect}_review_fields",
            f"{aspect} review artifact missing required fields: {', '.join(missing)}",
            path,
        )
        return

    score = _as_number(entry.get("score"))
    if score is None:
        _append_issue(
            report,
            f"invalid_{aspect}_score",
            f"{aspect} review must include a numeric score.",
            path,
        )
    elif score < 8:
        _append_issue(
            report,
            f"{aspect}_score_below_threshold",
            f"{aspect} review score must be >= 8.",
            path,
        )

    blockers = _as_list(entry.get("blocking_findings", entry.get("blocking")))
    if blockers:
        _append_issue(
            report,
            f"{aspect}_review_blockers",
            f"{aspect} review must have no blocking findings.",
            path,
        )

    recommendation = str(entry.get("recommendation", "")).strip().lower()
    if recommendation not in ALLOWED_RECOMMENDATION:
        _append_warning(
            report,
            f"{aspect}_recommendation_unexpected",
            f"{aspect} recommendation should be one of: approve, approve-with-caveats, changes-required.",
            path,
        )


def evaluate_factory_gates(
    root: Path,
    *,
    allow_missing_run: bool = False,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": True,
        "checked_at": now_iso(),
        "mode": "active-run",
        "issues": [],
        "warnings": [],
    }

    run_state = load_json(run_state_path(root), default={}) or {}
    if not run_state:
        if allow_missing_run:
            report["mode"] = "no-active-run"
            return report
        _append_issue(
            report,
            "missing_run_state",
            "Missing .factory/run.json.",
            ".factory/run.json",
        )
        return report

    if run_state.get("plan_status") != "approved":
        _append_issue(
            report,
            "plan_not_approved",
            "Plan status must be approved in .factory/run.json.",
            ".factory/run.json",
        )

    if run_state.get("decomposition_status") != "recorded":
        _append_issue(
            report,
            "decomposition_status_not_recorded",
            "Decomposition status must be recorded in .factory/run.json.",
            ".factory/run.json",
        )

    decomposition = load_json(decomposition_state_path(root), default={}) or {}
    if not decomposition:
        _append_issue(
            report,
            "missing_decomposition",
            "Missing .factory/decomposition.json.",
            ".factory/decomposition.json",
        )
    elif not isinstance(decomposition.get("tasks", []), list) or not decomposition.get("tasks"):
        _append_issue(
            report,
            "empty_decomposition_tasks",
            "Decomposition must include at least one task in .factory/decomposition.json.",
            ".factory/decomposition.json",
        )

    verify = load_json(verify_state_path(root), default={}) or {}
    if not verify:
        _append_issue(
            report,
            "missing_verify_artifact",
            "Missing .factory/verify.json.",
            ".factory/verify.json",
        )
    else:
        if not bool(verify.get("ok")):
            _append_issue(
                report,
                "verify_not_ok",
                "Deterministic verification must pass (`ok: true`).",
                ".factory/verify.json",
            )
        results = verify.get("results")
        if not isinstance(results, list) or not results:
            _append_issue(
                report,
                "verify_missing_results",
                "verify.json must include non-empty `results`.",
                ".factory/verify.json",
            )

    tests = load_json(tests_state_path(root), default={}) or {}
    if not tests:
        _append_issue(
            report,
            "missing_tests_artifact",
            "Missing .factory/tests.json.",
            ".factory/tests.json",
        )
    else:
        for kind in ("automated", "functional"):
            entry = tests.get(kind)
            if not isinstance(entry, dict) or not entry:
                _append_issue(
                    report,
                    f"missing_{kind}_tests",
                    f"Missing `{kind}` testing artifact in .factory/tests.json.",
                    ".factory/tests.json",
                )
                continue
            _validate_test_entry(report, kind, entry)

    for aspect in REVIEW_ASPECTS:
        review = load_json(review_dir(root) / f"{aspect}.json", default={}) or {}
        if not review:
            _append_issue(
                report,
                f"missing_{aspect}_review",
                f"Missing .factory/reviews/{aspect}.json.",
                f".factory/reviews/{aspect}.json",
            )
            continue
        _validate_review_entry(report, aspect, review)

    return report


def first_issue_reason(report: dict[str, Any]) -> str:
    issues = report.get("issues") or []
    if not issues:
        return "Factory validation failed."
    return str(issues[0].get("message") or "Factory validation failed.")


def report_lines(report: dict[str, Any]) -> list[str]:
    mode = report.get("mode", "active-run")
    if mode == "no-active-run":
        return ["No active factory run. Validation skipped."]

    lines: list[str] = []
    for issue in report.get("issues", []):
        path = issue.get("path")
        suffix = f" ({path})" if path else ""
        lines.append(f"- {issue.get('message')}{suffix}")
    for warning in report.get("warnings", []):
        path = warning.get("path")
        suffix = f" ({path})" if path else ""
        lines.append(f"- [warning] {warning.get('message')}{suffix}")
    return lines
