import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve('scripts/workflow/platform-loop-sync.sh');

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('platform-loop-sync launcher helper', () => {
  let tempDir: string;
  let binDir: string;
  let sourceRoot: string;
  let worktreePath: string;
  let excludePath: string;
  let gitLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-loop-sync-'));
    binDir = path.join(tempDir, 'bin');
    sourceRoot = path.join(tempDir, 'source-root');
    worktreePath = path.join(tempDir, 'platform-worktree');
    excludePath = path.join(tempDir, 'git-info', 'exclude');
    gitLogPath = path.join(tempDir, 'git.log');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, '.claude', 'commands'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sourceRoot, 'scripts', 'workflow'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sourceRoot, '.claude', 'commands', 'platform-pickup.md'),
      'latest pickup command\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop.js'),
      'latest platform loop helper\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop-sync.sh'),
      'latest sync helper\n',
    );

    writeExecutable(
      path.join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail

log_file="\${FAKE_GIT_LOG:?}"
exclude_path="\${FAKE_GIT_EXCLUDE_PATH:?}"
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
  fetch)
    if [[ "\${FAKE_GIT_FETCH_FAIL:-0}" == "1" ]]; then
      echo "fetch failed" >&2
      exit 1
    fi
    exit 0
    ;;
  rev-parse)
    if [[ "\${1:-}" == "--verify" ]]; then
      if [[ "\${FAKE_GIT_MISSING_REF:-0}" == "1" ]]; then
        exit 1
      fi
      echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      exit 0
    fi
    if [[ "\${1:-}" == "--git-path" ]]; then
      mkdir -p "$(dirname "$exclude_path")"
      echo "$exclude_path"
      exit 0
    fi
    if [[ "\${1:-}" == "--short" ]]; then
      echo "deadbee"
      exit 0
    fi
    ;;
  status)
    printf '%s' "\${FAKE_GIT_STATUS:-}"
    exit 0
    ;;
  worktree)
    if [[ "\${1:-}" == "add" ]]; then
      shift
      if [[ "\${1:-}" == "-B" ]]; then
        shift 2
      fi
      mkdir -p "$1"
      exit 0
    fi
    ;;
  checkout)
    exit 0
    ;;
esac

echo "unsupported fake git invocation: $cmd $*" >&2
exit 1
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runSync(args: string[] = [], extraEnv: Record<string, string> = {}) {
    return execFileSync('bash', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLogPath,
        FAKE_GIT_EXCLUDE_PATH: excludePath,
        NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT: sourceRoot,
        NANOCLAW_PLATFORM_LOOP_WORKTREE: worktreePath,
        NANOCLAW_PLATFORM_LOOP_BRANCH: 'claude-platform-loop',
        NANOCLAW_PLATFORM_LOOP_BASE_BRANCH: 'main',
        NANOCLAW_PLATFORM_LOOP_REMOTE: 'origin',
        ...extraEnv,
      },
    });
  }

  it('syncs the dedicated worktree and overlays helper files', () => {
    const output = runSync();

    expect(output).toContain(
      `platform-loop-sync: synced ${worktreePath} to origin/main (deadbee)`,
    );
    expect(
      fs.readFileSync(
        path.join(worktreePath, '.claude', 'commands', 'platform-pickup.md'),
        'utf8',
      ),
    ).toBe('latest pickup command\n');
    expect(
      fs.readFileSync(
        path.join(worktreePath, 'scripts', 'workflow', 'platform-loop.js'),
        'utf8',
      ),
    ).toBe('latest platform loop helper\n');
    expect(
      fs.readFileSync(
        path.join(worktreePath, 'scripts', 'workflow', 'platform-loop-sync.sh'),
        'utf8',
      ),
    ).toBe('latest sync helper\n');

    const exclude = fs.readFileSync(excludePath, 'utf8');
    expect(exclude).toContain('.claude/commands/platform-pickup.md');
    expect(exclude).toContain('.claude/scheduled_tasks.lock');
    expect(exclude).toContain('scripts/workflow/platform-loop.js');
    expect(exclude).toContain('scripts/workflow/platform-loop-sync.sh');

    const gitLog = fs.readFileSync(gitLogPath, 'utf8');
    expect(gitLog).toContain(`| fetch | --prune origin main`);
    expect(gitLog).toContain(
      `| worktree | add -B claude-platform-loop ${worktreePath} origin/main`,
    );
    expect(gitLog).toContain(
      `| checkout | -B claude-platform-loop origin/main`,
    );
  });

  it('fails closed when fetch does not succeed', () => {
    expect(() => runSync([], { FAKE_GIT_FETCH_FAIL: '1' })).toThrowError(
      /fetch failed/,
    );
  });

  it('refuses to reseed a dirty worktree', () => {
    fs.mkdirSync(worktreePath, { recursive: true });

    expect(() =>
      runSync([], {
        FAKE_GIT_STATUS: ' M scripts/workflow/platform-loop.js\n',
      }),
    ).toThrowError(/refusing to reseed dirty worktree/);
  });

  it('supports dry-run without creating the worktree', () => {
    const output = runSync(['--dry-run']);

    expect(output).toContain('platform-loop-sync: dry-run');
    expect(output).toContain(
      `platform-loop-sync: worktree_path=${worktreePath}`,
    );
    expect(output).toContain(
      `git -C ${path.resolve('')} worktree add -B claude-platform-loop ${worktreePath} origin/main`,
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(gitLogPath)).toBe(false);
  });
});
