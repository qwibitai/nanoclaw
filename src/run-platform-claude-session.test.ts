import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(
  'scripts/workflow/run-platform-claude-session.sh',
);

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('run-platform-claude-session', () => {
  let tempDir: string;
  let binDir: string;
  let worktreePath: string;
  let gitLogPath: string;
  let claudeArgsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-platform-claude-'));
    binDir = path.join(tempDir, 'bin');
    worktreePath = path.join(tempDir, 'platform-worktree');
    gitLogPath = path.join(tempDir, 'git.log');
    claudeArgsPath = path.join(tempDir, 'claude-args.txt');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    writeExecutable(
      path.join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail

log_file="\${FAKE_GIT_LOG:?}"
workdir="$PWD"
if [[ "\${1:-}" == "-C" ]]; then
  workdir="$2"
  shift 2
fi

cmd="\${1:-}"
if [[ -n "$cmd" ]]; then
  shift
fi
printf '%s | %s | %s\\n' "$workdir" "$cmd" "$*" >>"$log_file"

case "$cmd" in
  status)
    if [[ "$workdir" == "${worktreePath}" ]]; then
      printf '%s' "\${FAKE_GIT_STATUS_OUTPUT:-}"
      exit 0
    fi
    ;;
  worktree)
    subcmd="\${1:-}"
    shift || true
    if [[ "$subcmd" == "remove" ]]; then
      target="\${1:-}"
      rm -rf "$target"
      exit 0
    fi
    ;;
esac

exit 0
`,
    );

    writeExecutable(
      path.join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "switch" ]]; then
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(binDir, 'claude'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >"${claudeArgsPath}"
exit "\${FAKE_CLAUDE_EXIT_CODE:-0}"
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runSession(extraEnv: Record<string, string> = {}) {
    return execFileSync(
      'bash',
      [SCRIPT_PATH, '--worktree', worktreePath, '--prompt', '/platform-pickup'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_GIT_LOG: gitLogPath,
          ...extraEnv,
        },
      },
    );
  }

  function runSessionCaptured(extraEnv: Record<string, string> = {}) {
    return spawnSync(
      'bash',
      [SCRIPT_PATH, '--worktree', worktreePath, '--prompt', '/platform-pickup'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_GIT_LOG: gitLogPath,
          ...extraEnv,
        },
      },
    );
  }

  it('removes a clean worktree after Claude exits', () => {
    const output = runSession();

    expect(output).toContain(
      `platform-loop-runner: removed clean worktree ${worktreePath}`,
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.readFileSync(claudeArgsPath, 'utf8')).toContain(
      '--permission-mode bypassPermissions /platform-pickup',
    );
    expect(fs.readFileSync(gitLogPath, 'utf8')).toContain(
      `${path.resolve('')} | worktree | remove ${worktreePath}`,
    );
  });

  it('preserves a dirty worktree for handoff', () => {
    const result = runSessionCaptured({
      FAKE_GIT_STATUS_OUTPUT: ' M src/example.ts\n',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `platform-loop-runner: preserving dirty worktree at ${worktreePath}`,
    );
    expect(result.stderr).toContain(' M src/example.ts');
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(gitLogPath, 'utf8')).not.toContain(
      `${path.resolve('')} | worktree | remove ${worktreePath}`,
    );
  });
});
