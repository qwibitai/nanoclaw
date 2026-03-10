import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(
  'scripts/workflow/platform-loop-worktree-hygiene.sh',
);

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('platform-loop worktree hygiene', () => {
  let tempDir: string;
  let binDir: string;
  let rootDir: string;
  let worktreePath: string;
  let gitLogPath: string;
  let pruneMarkerPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-loop-hygiene-'));
    binDir = path.join(tempDir, 'bin');
    rootDir = path.join(tempDir, 'repo');
    worktreePath = path.join(rootDir, '.worktrees', 'platform-loop');
    gitLogPath = path.join(tempDir, 'git.log');
    pruneMarkerPath = path.join(tempDir, 'pruned.marker');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });

    writeExecutable(
      path.join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail

log_file="\${FAKE_GIT_LOG:?}"
worktree_path="\${FAKE_WORKTREE_PATH:?}"
prune_marker="\${FAKE_PRUNE_MARKER:?}"
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
  worktree)
    subcmd="\${1:-}"
    shift || true
    case "$subcmd" in
      list)
        if [[ "\${FAKE_WORKTREE_LIST_PRESENT:-0}" == "1" ]]; then
          if [[ -f "$prune_marker" && ! -d "$worktree_path" ]]; then
            exit 0
          fi
          printf 'worktree %s\\n' "$worktree_path"
        fi
        exit 0
        ;;
      prune)
        touch "$prune_marker"
        exit 0
        ;;
      remove)
        rm -rf "$1"
        exit 0
        ;;
    esac
    ;;
  status)
    printf '%s' "\${FAKE_GIT_STATUS_OUTPUT:-}"
    exit 0
    ;;
  rev-parse)
    if [[ "\${1:-}" == "--abbrev-ref" ]]; then
      printf '%s\\n' "\${FAKE_GIT_BRANCH:-claude-platform-loop}"
      exit 0
    fi
    ;;
esac

exit 0
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runHygiene(extraEnv: Record<string, string> = {}) {
    return execFileSync('bash', [SCRIPT_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLogPath,
        FAKE_WORKTREE_PATH: worktreePath,
        FAKE_PRUNE_MARKER: pruneMarkerPath,
        NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT: rootDir,
        NANOCLAW_PLATFORM_LOOP_WORKTREE: worktreePath,
        ...extraEnv,
      },
    });
  }

  it('prunes a stale worktree entry when the directory is missing', () => {
    const output = runHygiene({
      FAKE_WORKTREE_LIST_PRESENT: '1',
    });

    expect(output).toContain(
      'session-start: pruned stale platform-loop worktree entry',
    );
  });

  it('removes a clean leftover worktree', () => {
    fs.mkdirSync(worktreePath, { recursive: true });

    const output = runHygiene({
      FAKE_WORKTREE_LIST_PRESENT: '1',
    });

    expect(output).toContain(
      `session-start: removed clean leftover platform-loop worktree at ${worktreePath}`,
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('retains a dirty leftover worktree and reports the branch', () => {
    fs.mkdirSync(worktreePath, { recursive: true });

    const output = runHygiene({
      FAKE_WORKTREE_LIST_PRESENT: '1',
      FAKE_GIT_STATUS_OUTPUT: ' M src/example.ts\n',
      FAKE_GIT_BRANCH: 'claude-platform-123',
    });

    expect(output).toContain(
      `session-start: retained dirty platform-loop worktree at ${worktreePath} (branch: claude-platform-123)`,
    );
    expect(output).toContain(' M src/example.ts');
    expect(fs.existsSync(worktreePath)).toBe(true);
  });
});
