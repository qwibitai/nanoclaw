"""
Hook test harness — Python edition.

Simulates Claude Code's hook runner with proper JSON handling,
subprocess isolation, and pytest integration.

Usage:
    from harness import HookHarness, PreToolUseInput, PostToolUseInput

    h = HookHarness()
    result = h.run_hook("enforce-pr-review.sh", PreToolUseInput.bash("npm test"))
    assert result.allows()

    # Or run all hooks for an event (parallel, like Claude Code)
    results = h.run_all_hooks("PreToolUse", "Bash", PreToolUseInput.bash("npm test"))
    assert results.all_allow()
"""

import json
import os
import re
import subprocess
import tempfile
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


HOOKS_DIR = Path(__file__).parent.parent
SETTINGS_PATH = HOOKS_DIR.parent / "settings.json"


# Input builders — construct schema-compliant event JSON

@dataclass
class PreToolUseInput:
    tool_name: str
    tool_input: dict
    session_id: str = "test-session"
    cwd: str = field(default_factory=os.getcwd)

    def to_json(self) -> str:
        return json.dumps({
            "session_id": self.session_id,
            "transcript_path": "/tmp/test-transcript.txt",
            "cwd": self.cwd,
            "permission_mode": "default",
            "hook_event_name": "PreToolUse",
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
        })

    @classmethod
    def bash(cls, command: str, **kwargs) -> "PreToolUseInput":
        return cls(tool_name="Bash", tool_input={"command": command}, **kwargs)

    @classmethod
    def write(cls, file_path: str, content: str = "test", **kwargs) -> "PreToolUseInput":
        return cls(tool_name="Write", tool_input={"file_path": file_path, "content": content}, **kwargs)

    @classmethod
    def edit(cls, file_path: str, old_string: str = "", new_string: str = "", **kwargs) -> "PreToolUseInput":
        return cls(tool_name="Edit", tool_input={
            "file_path": file_path, "old_string": old_string, "new_string": new_string
        }, **kwargs)


@dataclass
class PostToolUseInput:
    tool_name: str
    tool_input: dict
    stdout: str = ""
    stderr: str = ""
    exit_code: str = "0"
    session_id: str = "test-session"
    cwd: str = field(default_factory=os.getcwd)

    def to_json(self) -> str:
        return json.dumps({
            "session_id": self.session_id,
            "transcript_path": "/tmp/test-transcript.txt",
            "cwd": self.cwd,
            "permission_mode": "default",
            "hook_event_name": "PostToolUse",
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "tool_response": {
                "stdout": self.stdout,
                "stderr": self.stderr,
                "exit_code": self.exit_code,
            },
        })

    @classmethod
    def bash(cls, command: str, stdout: str = "", stderr: str = "", exit_code: str = "0", **kwargs) -> "PostToolUseInput":
        return cls(tool_name="Bash", tool_input={"command": command},
                   stdout=stdout, stderr=stderr, exit_code=exit_code, **kwargs)


@dataclass
class StopInput:
    reason: str = "task_complete"
    session_id: str = "test-session"
    cwd: str = field(default_factory=os.getcwd)

    def to_json(self) -> str:
        return json.dumps({
            "session_id": self.session_id,
            "transcript_path": "/tmp/test-transcript.txt",
            "cwd": self.cwd,
            "permission_mode": "default",
            "hook_event_name": "Stop",
            "reason": self.reason,
        })


# Hook execution results

@dataclass
class HookResult:
    hook_path: str
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False

    def allows(self) -> bool:
        """Returns True if hook allows the action (no deny decision)."""
        if self.exit_code != 0 and self.exit_code != 2:
            return True  # crash = not a valid deny
        if not self.stdout.strip():
            return True
        try:
            data = json.loads(self.stdout)
            return data.get("hookSpecificOutput", {}).get("permissionDecision") != "deny"
        except (json.JSONDecodeError, TypeError):
            return True

    def denies(self) -> bool:
        return not self.allows() and self.has_valid_deny_json()

    def has_valid_deny_json(self) -> bool:
        """Validates deny output matches Claude Code's expected schema."""
        if not self.stdout.strip():
            return False
        try:
            data = json.loads(self.stdout)
            hso = data.get("hookSpecificOutput", {})
            return (
                hso.get("permissionDecision") == "deny"
                and bool(hso.get("permissionDecisionReason"))
                and self.exit_code == 0  # deny is communicated via JSON, not exit code
            )
        except (json.JSONDecodeError, TypeError):
            return False

    def deny_reason(self) -> str:
        try:
            data = json.loads(self.stdout)
            return data.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        except (json.JSONDecodeError, TypeError):
            return ""

    @property
    def name(self) -> str:
        return Path(self.hook_path).name


@dataclass
class MultiHookResult:
    results: list[HookResult]

    def all_allow(self) -> bool:
        return all(r.allows() for r in self.results)

    def any_deny(self) -> bool:
        return any(r.denies() for r in self.results)

    def denying_hooks(self) -> list[HookResult]:
        return [r for r in self.results if r.denies()]

    def crashed_hooks(self) -> list[HookResult]:
        return [r for r in self.results if r.exit_code not in (0, 2)]


# Main harness

class HookHarness:
    def __init__(self, hooks_dir: Optional[Path] = None, settings_path: Optional[Path] = None):
        self.hooks_dir = hooks_dir or HOOKS_DIR
        self.settings_path = settings_path or SETTINGS_PATH
        self.temp_dir = Path(tempfile.mkdtemp(prefix="hook-harness-"))
        self.env_overrides: dict[str, str] = {}

    def cleanup(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()

    def set_env(self, key: str, value: str):
        """Set an environment variable override for all hook runs."""
        self.env_overrides[key] = value

    def run_hook(self, hook_name: str, input_data, timeout: int = 10) -> HookResult:
        """Run a single hook with given input."""
        hook_path = self.hooks_dir / hook_name
        if not hook_path.exists():
            raise FileNotFoundError(f"Hook not found: {hook_path}")

        env = os.environ.copy()
        env.update(self.env_overrides)

        input_json = input_data.to_json() if hasattr(input_data, 'to_json') else str(input_data)

        try:
            proc = subprocess.run(
                ["bash", str(hook_path)],
                input=input_json,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                cwd=env.get("CWD", os.getcwd()),
            )
            return HookResult(
                hook_path=str(hook_path),
                stdout=proc.stdout,
                stderr=proc.stderr,
                exit_code=proc.returncode,
            )
        except subprocess.TimeoutExpired:
            return HookResult(
                hook_path=str(hook_path),
                stdout="",
                stderr=f"TIMEOUT after {timeout}s",
                exit_code=124,
                timed_out=True,
            )

    def run_all_hooks(self, event: str, tool_name: str, input_data, timeout: int = 10) -> MultiHookResult:
        """Run all configured hooks for event+tool (sequentially, unlike Claude Code's parallel)."""
        hooks = self._get_hooks_for_event(event, tool_name)
        results = []
        for hook_cmd in hooks:
            hook_path = self._resolve_hook_path(hook_cmd)
            if hook_path and hook_path.exists():
                result = self.run_hook(hook_path.name, input_data, timeout)
                results.append(result)
        return MultiHookResult(results=results)

    def _get_hooks_for_event(self, event: str, tool_name: str) -> list[str]:
        """Parse settings.json to find hooks for event+tool."""
        if not self.settings_path.exists():
            return []
        try:
            settings = json.loads(self.settings_path.read_text())
            hooks_config = settings.get("hooks", {})
            event_hooks = hooks_config.get(event, [])
            result = []
            for entry in event_hooks:
                matcher = entry.get("matcher", "*")
                pattern = matcher.replace("*", ".*")
                if re.match(f"^({pattern})$", tool_name):
                    for hook in entry.get("hooks", []):
                        cmd = hook.get("command", "")
                        if cmd:
                            result.append(cmd)
            return result
        except (json.JSONDecodeError, KeyError):
            return []

    def _resolve_hook_path(self, hook_cmd: str) -> Optional[Path]:
        """Resolve a hook command to a Path."""
        if hook_cmd.startswith("./"):
            return self.hooks_dir.parent.parent / hook_cmd[2:]
        return Path(hook_cmd)


# State file helpers for PR review testing

class PRReviewState:
    """Manages PR review state files for testing."""

    def __init__(self, state_dir: Optional[Path] = None):
        self.state_dir = state_dir or Path(tempfile.mkdtemp(prefix="pr-review-state-"))
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        shutil.rmtree(self.state_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()

    def create_state(self, pr_url: str, round_num: int = 1, status: str = "needs_review"):
        """Create a state file for a PR."""
        filename = pr_url.replace("https://github.com/", "").replace("/pull/", "_").replace("/", "_")
        state_file = self.state_dir / filename
        state_file.write_text(f"PR_URL={pr_url}\nROUND={round_num}\nSTATUS={status}\n")
        state_file.chmod(0o600)

    def read_state(self, pr_url: str) -> Optional[dict]:
        """Read state for a PR."""
        filename = pr_url.replace("https://github.com/", "").replace("/pull/", "_").replace("/", "_")
        state_file = self.state_dir / filename
        if not state_file.exists():
            return None
        content = state_file.read_text()
        result = {}
        for line in content.strip().split("\n"):
            if "=" in line:
                key, val = line.split("=", 1)
                result[key] = val
        return result

    def state_exists(self, pr_url: str) -> bool:
        filename = pr_url.replace("https://github.com/", "").replace("/pull/", "_").replace("/", "_")
        return (self.state_dir / filename).exists()

    def state_count(self) -> int:
        return len(list(self.state_dir.iterdir()))


# Mock git/gh helpers

class MockBinDir:
    """Creates mock git/gh binaries for testing."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="mock-bin-"))
        self._original_path = os.environ.get("PATH", "")

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()

    @property
    def path_with_mocks(self) -> str:
        """PATH string with mock dir prepended."""
        return f"{self.dir}:{self._original_path}"

    def add_git_mock(self, branch: str = "wt/test", status_output: str = "",
                     diff_output: str = "", remote_url: str = "https://github.com/Garsson-io/nanoclaw.git"):
        """Create a mock git binary."""
        script = f"""#!/bin/bash
if echo "$@" | grep -q "status --porcelain"; then
  printf '%s' '{status_output}'
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "{branch}"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  printf '%s' '{diff_output}'
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "{remote_url}"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo ".git"
  exit 0
fi
/usr/bin/git "$@" 2>/dev/null
"""
        mock_path = self.dir / "git"
        mock_path.write_text(script)
        mock_path.chmod(0o755)

    def add_gh_mock(self, pr_diff_output: str = "", pr_view_body: str = ""):
        """Create a mock gh binary."""
        script = f"""#!/bin/bash
if echo "$@" | grep -q "pr diff"; then
  printf '%s' '{pr_diff_output}'
  exit 0
fi
if echo "$@" | grep -q "pr view"; then
  printf '%s' '{pr_view_body}'
  exit 0
fi
exit 0
"""
        mock_path = self.dir / "gh"
        mock_path.write_text(script)
        mock_path.chmod(0o755)


# Real-world command fixtures

REAL_COMMANDS = {
    "pr_create_heredoc": '''gh pr create --title "fix: address review findings" --body "$(cat <<'EOF'
## Summary
- Fixed prompt formatting
- Added missing imports

## Test plan
- [x] Unit tests pass

## Verification
- [ ] Run `npm run build`
- [ ] Send test message

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"''',

    "pr_create_simple": 'gh pr create --title "test" --body "## Verification\\n- check it"',

    "pr_create_piped": 'gh pr create --title "test" --body "## Verification\\n- ok" | tee /tmp/pr.log',

    "git_push_tracked": "git push -u origin wt/260315-1430-fix-auth",

    "git_push_simple": "git push",

    "pr_merge_squash": "gh pr merge 47 --repo Garsson-io/nanoclaw --squash --delete-branch",

    "pr_diff": "gh pr diff 47 --repo Garsson-io/nanoclaw",

    "chained_commit_push": 'git add src/index.ts && git commit -m "fix: update routing" && git push origin wt/test',

    "heredoc_with_gh_text": '''cat > /tmp/docs.md << 'EOF'
To create a PR, run:
  gh pr create --title "your title" --body "description"
  git push origin your-branch
EOF''',

    "complex_multiline": '''gh pr create \\
  --title "feat: add voice transcription" \\
  --body "## Summary
Added whisper integration

## Verification
- Run npm test"''',
}
