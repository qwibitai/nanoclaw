from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from factory_gates import evaluate_factory_gates  # noqa: E402


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


class FactoryGatesTests(unittest.TestCase):
    def test_allow_missing_run_passes_in_scaffold_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report = evaluate_factory_gates(root, allow_missing_run=True)
            self.assertTrue(report["ok"])
            self.assertEqual(report["mode"], "no-active-run")

    def test_missing_artifacts_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(
                root / ".factory" / "run.json",
                {"plan_status": "approved", "decomposition_status": "recorded"},
            )
            report = evaluate_factory_gates(root)
            self.assertFalse(report["ok"])
            messages = [issue["message"] for issue in report["issues"]]
            self.assertTrue(any("Missing .factory/decomposition.json." in msg for msg in messages))
            self.assertTrue(any("Missing .factory/verify.json." in msg for msg in messages))
            self.assertTrue(any("Missing .factory/tests.json." in msg for msg in messages))

    def test_complete_artifacts_pass_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(
                root / ".factory" / "run.json",
                {"plan_status": "approved", "decomposition_status": "recorded"},
            )
            write_json(
                root / ".factory" / "decomposition.json",
                {"tasks": [{"id": "ENG-1", "title": "Test task"}]},
            )
            write_json(
                root / ".factory" / "verify.json",
                {"ok": True, "results": [{"phase": "tests", "exit_code": 0}]},
            )
            write_json(
                root / ".factory" / "tests.json",
                {
                    "automated": {
                        "status": "passed",
                        "summary": "Automated tests pass.",
                        "tests_added_or_updated": ["src/foo.test.ts"],
                        "commands_run": ["pnpm test"],
                        "pass_fail_summary": "all passed",
                        "blocking_findings": [],
                        "remaining_gaps": [],
                        "reviewed_scope": ["src/foo.ts"],
                    },
                    "functional": {
                        "status": "passed",
                        "score": 9,
                        "summary": "Functional checks pass.",
                        "manual_validation_steps": ["Open page", "Submit form"],
                        "blocking_findings": [],
                        "non_blocking_findings": [],
                        "residual_risks": [],
                        "recommendation": "approve",
                        "reviewed_scope": ["src/foo.ts"],
                    },
                },
            )
            for aspect in ("quality", "performance", "security"):
                write_json(
                    root / ".factory" / "reviews" / f"{aspect}.json",
                    {
                        "score": 9,
                        "summary": f"{aspect} review ok",
                        "blocking_findings": [],
                        "non_blocking_findings": [],
                        "residual_risks": [],
                        "recommendation": "approve",
                        "reviewed_scope": ["src/foo.ts"],
                    },
                )

            report = evaluate_factory_gates(root)
            self.assertTrue(report["ok"])
            self.assertEqual(report["issues"], [])


if __name__ == "__main__":
    unittest.main()
