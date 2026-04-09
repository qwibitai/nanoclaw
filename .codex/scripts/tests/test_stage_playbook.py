from __future__ import annotations

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stage_playbook import STAGE_PLAYBOOK, render_stage_context, stage_spec_for_phase  # noqa: E402


class StagePlaybookTests(unittest.TestCase):
    def test_required_runtime_stages_have_playbook_entries(self) -> None:
        for phase in (
            "planning",
            "decomposing",
            "awaiting-approval",
            "implementing",
            "testing",
            "reviewing",
            "functional-check",
            "pr-ready",
            "done",
            "blocked",
        ):
            self.assertIn(phase, STAGE_PLAYBOOK)

    def test_reviewing_stage_uses_three_review_subagents(self) -> None:
        spec = stage_spec_for_phase("reviewing")
        self.assertEqual(
            spec["agents"],
            ["quality-reviewer", "performance-reviewer", "security-reviewer"],
        )

    def test_render_stage_context_includes_phase_goal_and_agents(self) -> None:
        text = render_stage_context(
            {"phase": "testing", "issue_key": "ENG-123", "title": "Add checkout flow"},
        )
        self.assertIn("phase=`testing`", text)
        self.assertIn("automated-tester", text)
        self.assertIn("Goal:", text)


if __name__ == "__main__":
    unittest.main()
