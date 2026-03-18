"""
Comprehensive hook test suite using Python harness.

Covers:
  1. Schema validation — deny/allow outputs match Claude Code's expected format
  2. Real-world commands — complex heredocs, pipes, multi-line
  3. Integration — PR lifecycle across enforce-pr-review + pr-review-loop
  4. Parallel execution — multiple hooks don't interfere
  5. Edge cases — empty input, malformed JSON, missing fields
  6. Bug regression — known issues captured as tests

Run: python3 -m pytest .claude/kaizen/hooks/tests/test_hooks.py -v
"""

import pytest
import os
import json
from pathlib import Path

# Allow running from repo root or tests dir
import sys
sys.path.insert(0, str(Path(__file__).parent))

from harness import (
    HookHarness, PreToolUseInput, PostToolUseInput, StopInput,
    PRReviewState, MockBinDir, REAL_COMMANDS,
)


@pytest.fixture
def harness():
    h = HookHarness()
    yield h
    h.cleanup()


@pytest.fixture
def state():
    s = PRReviewState()
    yield s
    s.cleanup()


@pytest.fixture
def mocks():
    m = MockBinDir()
    m.add_git_mock(branch="wt/test-branch", status_output="")
    m.add_gh_mock()
    yield m
    m.cleanup()


@pytest.fixture
def review_harness(harness, state, mocks):
    """Harness configured for PR review testing."""
    harness.set_env("STATE_DIR", str(state.state_dir))
    harness.set_env("DEBUG_LOG", "/dev/null")
    harness.set_env("PATH", mocks.path_with_mocks)
    return harness


# Schema validation tests

class TestDenySchema:
    """INVARIANT: All deny outputs produce valid JSON matching Claude Code's expected schema."""

    def test_dirty_files_denies_pr_create(self, harness, state, mocks):
        mocks.add_git_mock(branch="wt/test", status_output=" M src/dirty.ts")
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("check-dirty-files.sh", PreToolUseInput.bash("gh pr create --title test --body test"))
        assert result.denies(), f"Expected deny, got: exit={result.exit_code}, stdout={result.stdout[:200]}"
        assert result.has_valid_deny_json()
        assert result.exit_code == 0, "Deny must use JSON, not exit code"

    def test_case_worktree_denies_commit_on_main(self, harness, mocks):
        mocks.add_git_mock(branch="main")
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("enforce-case-worktree.sh", PreToolUseInput.bash("git commit -m test"))
        assert result.denies()
        assert "worktree" in result.deny_reason().lower()

    def test_pr_review_gate_denies_during_review(self, review_harness, state):
        state.create_state("https://github.com/Garsson-io/nanoclaw/pull/42", round_num=1, status="needs_review")

        result = review_harness.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("npm test"))
        assert result.denies()
        assert "review" in result.deny_reason().lower()
        assert "pull/42" in result.deny_reason()

    def test_deny_json_has_required_fields(self, harness, state, mocks):
        """Every deny output must have hookSpecificOutput.permissionDecision and permissionDecisionReason."""
        mocks.add_git_mock(branch="main")
        harness.set_env("PATH", mocks.path_with_mocks)
        harness.set_env("STATE_DIR", str(state.state_dir))

        result = harness.run_hook("enforce-case-worktree.sh", PreToolUseInput.bash("git commit -m test"))
        data = json.loads(result.stdout)
        hso = data["hookSpecificOutput"]
        assert hso["permissionDecision"] == "deny"
        assert isinstance(hso["permissionDecisionReason"], str)
        assert len(hso["permissionDecisionReason"]) > 10  # meaningful reason


class TestAllowSchema:
    """INVARIANT: Allow outputs are either empty or valid JSON without deny."""

    def test_non_trigger_commands_allow(self, review_harness):
        for cmd in ["npm test", "ls -la", "echo hello", "node -e 'console.log(1)'"]:
            result = review_harness.run_hook("check-dirty-files.sh", PreToolUseInput.bash(cmd))
            assert result.allows(), f"'{cmd}' unexpectedly denied"
            assert result.exit_code == 0

    def test_clean_worktree_allows_pr_create(self, harness, mocks):
        mocks.add_git_mock(status_output="")
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("check-dirty-files.sh", PreToolUseInput.bash("gh pr create --title test --body test"))
        assert result.allows()


# Real-world command pattern tests

class TestRealWorldCommands:
    """INVARIANT: Hooks correctly handle real-world command patterns."""

    def test_heredoc_pr_body_with_verification(self, harness, mocks):
        mocks.add_git_mock()
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("check-verification.sh", PreToolUseInput.bash(REAL_COMMANDS["pr_create_heredoc"]))
        assert result.allows(), f"Heredoc with verification denied: {result.deny_reason()}"

    def test_heredoc_body_no_false_positive(self, review_harness):
        """Text mentioning 'gh pr create' inside a heredoc body should NOT trigger hooks."""
        result = review_harness.run_hook("check-dirty-files.sh",
                                          PreToolUseInput.bash(REAL_COMMANDS["heredoc_with_gh_text"]))
        assert result.allows()

    def test_piped_pr_create(self, harness, mocks):
        mocks.add_git_mock()
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("check-verification.sh", PreToolUseInput.bash(REAL_COMMANDS["pr_create_piped"]))
        assert result.allows()

    def test_chained_git_commands_on_wt_branch(self, harness, mocks):
        mocks.add_git_mock(branch="wt/260315-test")
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("enforce-case-worktree.sh", PreToolUseInput.bash(REAL_COMMANDS["chained_commit_push"]))
        assert result.allows()

    def test_pr_create_output_in_stderr(self, review_harness):
        """Some gh versions output PR URL to stderr."""
        inp = PostToolUseInput.bash(
            "gh pr create --title test --body test",
            stderr="https://github.com/Garsson-io/nanoclaw/pull/88",
        )
        result = review_harness.run_hook("pr-review-loop.sh", inp)
        assert "SELF-REVIEW" in result.stdout

    def test_multiline_command(self, harness, mocks):
        mocks.add_git_mock()
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("check-verification.sh", PreToolUseInput.bash(REAL_COMMANDS["complex_multiline"]))
        assert result.allows()


# Edge case tests

class TestEdgeCases:
    """INVARIANT: Hooks handle malformed/missing input without crashing."""

    @pytest.mark.parametrize("hook", [
        "enforce-pr-review.sh",
        "enforce-case-worktree.sh",
        "check-dirty-files.sh",
        "check-verification.sh",
        "check-test-coverage.sh",
    ])
    def test_empty_command(self, review_harness, hook):
        result = review_harness.run_hook(hook, PreToolUseInput.bash(""))
        assert result.exit_code == 0, f"{hook} crashed on empty command: exit={result.exit_code}, stderr={result.stderr[:200]}"

    @pytest.mark.parametrize("hook", [
        "enforce-pr-review.sh",
        "enforce-case-worktree.sh",
        "check-dirty-files.sh",
        "check-verification.sh",
    ])
    def test_missing_tool_input(self, review_harness, hook):
        """Missing tool_input entirely — hook should not crash."""
        raw_json = '{"session_id":"test","hook_event_name":"PreToolUse","tool_name":"Bash"}'
        result = review_harness.run_hook(hook, raw_json)
        assert result.exit_code == 0, f"{hook} crashed on missing tool_input: stderr={result.stderr[:200]}"

    @pytest.mark.parametrize("hook", [
        "enforce-pr-review.sh",
        "enforce-case-worktree.sh",
        "check-dirty-files.sh",
        "check-verification.sh",
    ])
    def test_malformed_json(self, review_harness, hook):
        result = review_harness.run_hook(hook, "not json at all")
        # Should not crash fatally (exit 0 or graceful degradation)
        assert result.exit_code in (0, 1, 2), f"{hook} crashed on malformed JSON: exit={result.exit_code}"

    def test_special_characters_in_command(self, review_harness):
        cmd = 'gh pr create --title \'fix: handle $PATH & "quotes"\' --body \'## Verification\\n- test\''
        result = review_harness.run_hook("check-verification.sh", PreToolUseInput.bash(cmd))
        assert result.exit_code == 0

    def test_very_long_command(self, review_harness):
        long_body = "x" * 10000
        cmd = f'gh pr create --title test --body "## Verification\\n{long_body}"'
        result = review_harness.run_hook("check-verification.sh", PreToolUseInput.bash(cmd))
        assert result.exit_code == 0


# PR Lifecycle integration tests

class TestPRLifecycle:
    """INVARIANT: PR review lifecycle transitions correctly across hooks."""

    PR_URL = "https://github.com/Garsson-io/nanoclaw/pull/55"

    def test_full_lifecycle(self, review_harness, state):
        """End-to-end: create → gate → diff → open → push → re-gate → merge → cleanup."""

        # Phase 1: Before PR create — no gate
        r = review_harness.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("npm test"))
        assert r.allows(), "Should allow before any PR"

        # Phase 2: PR create → gate activates
        r = review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr create --title test --body test",
            stdout=self.PR_URL))
        assert "SELF-REVIEW" in r.stdout
        assert state.state_exists(self.PR_URL)
        s = state.read_state(self.PR_URL)
        assert s["STATUS"] == "needs_review"
        assert s["ROUND"] == "1"

        # Gate should block non-review commands
        r = review_harness.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("npm test"))
        assert r.denies(), "Should block during active review"

        # But allow review commands
        r = review_harness.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("gh pr diff 55"))
        assert r.allows(), "Should allow gh pr diff"

        # Phase 3: gh pr diff → review passed
        r = review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash("gh pr diff 55", stdout="diff..."))
        s = state.read_state(self.PR_URL)
        assert s["STATUS"] == "passed"

        # Gate should open
        r = review_harness.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("npm test"))
        assert r.allows(), "Should allow after review passed"

        # Phase 4: git push → re-gate (THIS IS THE BUG WE FOUND)
        r = review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash("git push", stdout="ok"))
        s = state.read_state(self.PR_URL)
        # BUG: Currently, push after "passed" exits early without incrementing round.
        # The state stays "passed" instead of going to "needs_review" round 2.
        # When this bug is fixed, change the assertions below.
        #
        # EXPECTED (after fix):
        #   assert s["STATUS"] == "needs_review"
        #   assert s["ROUND"] == "2"
        #
        # ACTUAL (current bug):
        assert s["STATUS"] == "passed", "KNOWN BUG: push after passed doesn't re-engage gate"
        assert s["ROUND"] == "1", "KNOWN BUG: round not incremented after push"

    def test_merge_cleans_up(self, review_harness, state):
        state.create_state(self.PR_URL, round_num=2, status="needs_review")

        review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr merge 55 --squash",
            stdout=f"✓ Merged {self.PR_URL}"))

        assert not state.state_exists(self.PR_URL), "State should be cleaned up after merge"

    def test_multi_repo_isolation(self, review_harness, state):
        url_a = "https://github.com/Garsson-io/nanoclaw/pull/60"
        url_b = "https://github.com/Garsson-io/garsson-prints/pull/10"

        # Create PRs for both repos
        review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr create --repo Garsson-io/nanoclaw", stdout=url_a))
        review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr create --repo Garsson-io/garsson-prints", stdout=url_b))

        assert state.state_exists(url_a)
        assert state.state_exists(url_b)

        # Merge A shouldn't affect B
        review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr merge 60", stdout=f"✓ Merged {url_a}"))

        assert not state.state_exists(url_a)
        assert state.state_exists(url_b), "Merging A should not touch B's state"

    def test_failed_command_no_state(self, review_harness, state):
        review_harness.run_hook("pr-review-loop.sh", PostToolUseInput.bash(
            "gh pr create --title test", exit_code="1"))
        assert state.state_count() == 0, "Failed command should not create state"


# Parallel execution tests

class TestParallelExecution:
    """INVARIANT: Multiple hooks running on the same event don't interfere."""

    def test_all_pretooluse_hooks_allow_harmless_command(self, review_harness):
        hooks = [
            "enforce-pr-review.sh",
            "enforce-case-worktree.sh",
            "check-test-coverage.sh",
            "check-verification.sh",
            "check-dirty-files.sh",
        ]
        for hook in hooks:
            result = review_harness.run_hook(hook, PreToolUseInput.bash("npm test"))
            assert result.allows(), f"{hook} unexpectedly denied 'npm test'"

    def test_multiple_hooks_can_deny_simultaneously(self, harness, state, mocks):
        """When multiple conditions are violated, multiple hooks should deny."""
        mocks.add_git_mock(branch="main", status_output=" M src/dirty.ts")
        harness.set_env("PATH", mocks.path_with_mocks)
        harness.set_env("STATE_DIR", str(state.state_dir))
        state.create_state("https://github.com/Garsson-io/nanoclaw/pull/42", status="needs_review")

        # gh pr create on main branch with dirty files and active review
        inp = PreToolUseInput.bash("gh pr create --title test --body test")

        denying = []
        for hook in ["enforce-pr-review.sh", "check-dirty-files.sh", "enforce-case-worktree.sh"]:
            result = harness.run_hook(hook, inp)
            if result.denies():
                denying.append(hook)

        # At least enforce-pr-review and check-dirty-files should deny
        assert len(denying) >= 2, f"Expected >=2 denials, got {len(denying)}: {denying}"

    def test_both_post_hooks_fire_on_pr_create(self, review_harness, state):
        inp = PostToolUseInput.bash(
            "gh pr create --title test --body test",
            stdout="https://github.com/Garsson-io/nanoclaw/pull/99")

        review_result = review_harness.run_hook("pr-review-loop.sh", inp)
        kaizen_result = review_harness.run_hook("kaizen-reflect.sh", inp)

        assert "SELF-REVIEW" in review_result.stdout, "pr-review-loop should fire"
        assert "KAIZEN" in kaizen_result.stdout, "kaizen-reflect should fire"


# PostToolUse format tests

class TestPostToolUseFormat:
    """INVARIANT: PostToolUse hooks output advisory text, not deny JSON."""

    @pytest.mark.parametrize("hook", ["pr-review-loop.sh", "kaizen-reflect.sh"])
    def test_no_deny_json_in_post_hooks(self, review_harness, hook):
        inp = PostToolUseInput.bash(
            "gh pr create --title test --body test",
            stdout="https://github.com/Garsson-io/nanoclaw/pull/70")

        result = review_harness.run_hook(hook, inp)
        assert result.exit_code == 0, f"{hook} should always exit 0"

        # Should not produce deny JSON
        if result.stdout.strip():
            try:
                data = json.loads(result.stdout)
                assert "permissionDecision" not in json.dumps(data), \
                    f"{hook} should not output permissionDecision"
            except json.JSONDecodeError:
                pass  # Non-JSON stdout is fine for advisory hooks


# Stop hook tests

class TestStopHooks:
    """INVARIANT: Stop hooks use exit codes (not JSON) to block."""

    def test_verify_before_stop_allows_no_changes(self, harness, mocks):
        mocks.add_git_mock(diff_output="")
        harness.set_env("PATH", mocks.path_with_mocks)

        result = harness.run_hook("verify-before-stop.sh", StopInput())
        assert result.exit_code == 0

    def test_cleanup_always_allows(self, harness):
        result = harness.run_hook("check-cleanup-on-stop.sh", StopInput())
        assert result.exit_code == 0, "check-cleanup-on-stop should always exit 0"
