import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(
  'scripts/workflow/start-nightly-improvement.sh',
);

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('start-nightly-improvement launcher', () => {
  let tempDir: string;
  let binDir: string;
  let sourceRoot: string;
  let worktreePath: string;
  let excludePath: string;
  let gitLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'start-nightly-improvement-'),
    );
    binDir = path.join(tempDir, 'bin');
    sourceRoot = path.join(tempDir, 'source-root');
    worktreePath = path.join(tempDir, 'worktree');
    excludePath = path.join(tempDir, 'git-info', 'exclude');
    gitLogPath = path.join(tempDir, 'git.log');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, '.claude', 'commands'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sourceRoot, '.claude', 'agents'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sourceRoot, 'scripts', 'workflow'), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(sourceRoot, '.claude', 'commands', 'platform-pickup.md'),
      'platform pickup\n',
    );
    fs.writeFileSync(
      path.join(
        sourceRoot,
        '.claude',
        'commands',
        'nightly-improvement-eval.md',
      ),
      'nightly command\n',
    );
    fs.writeFileSync(
      path.join(
        sourceRoot,
        '.claude',
        'agents',
        'nightly-improvement-researcher.md',
      ),
      'nightly agent\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop.js'),
      'platform helper\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'nightly-improvement.js'),
      'nightly helper\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop-sync.sh'),
      'sync helper\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'autonomy-lane.sh'),
      'autonomy helper\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFakeGit() {
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
    exit 0
    ;;
  rev-parse)
    if [[ "\${1:-}" == "--verify" ]]; then
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
  }

  function writeFakeGh() {
    writeExecutable(
      path.join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "switch" ]]; then
  exit 0
fi
echo "unsupported gh invocation" >&2
exit 1
`,
    );
  }

  function writeFakeClaude(exitCode = 0) {
    writeExecutable(
      path.join(binDir, 'claude'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >"${tempDir}/claude-args.txt"
printf 'claude-called\\n'
exit ${exitCode}
`,
    );
  }

  function runLauncher(
    args: string[] = [],
    extraEnv: Record<string, string> = {},
  ) {
    return execFileSync('bash', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLogPath,
        FAKE_GIT_EXCLUDE_PATH: excludePath,
        NANOCLAW_NIGHTLY_SOURCE_ROOT: sourceRoot,
        NANOCLAW_NIGHTLY_WORKTREE: worktreePath,
        NANOCLAW_NIGHTLY_WORKTREE_BRANCH: 'claude-nightly-improvement',
        NANOCLAW_NIGHTLY_BASE_BRANCH: 'main',
        NANOCLAW_NIGHTLY_REMOTE: 'origin',
        ...extraEnv,
      },
    });
  }

  it(
    'prints a headless claude invocation in dry-run mode',
    { timeout: 15000 },
    () => {
      writeFakeGit();
      writeFakeGh();
      writeFakeClaude();

      const output = runLauncher(['--dry-run']);

      expect(output).toContain('claude -p');
      expect(output).toContain('--agent "nightly-improvement-researcher"');
      expect(output).toContain('--model "sonnet"');
      expect(output).toContain(`--add-dir "${sourceRoot}"`);
      expect(fs.existsSync(path.join(tempDir, 'claude-args.txt'))).toBe(false);
    },
  );

  it(
    'short-circuits on noop without invoking claude',
    { timeout: 15000 },
    () => {
      writeFakeGit();
      writeFakeGh();
      writeFakeClaude(99);
      fs.writeFileSync(
        path.join(sourceRoot, 'scripts', 'workflow', 'nightly-improvement.js'),
        `#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];
function optionValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

if (command === 'scan') {
  const outputPath = optionValue('--output');
  fs.mkdirSync(require('path').dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    action: 'noop',
    upstream: { pending: false },
    tooling: { candidates: [], currentVersions: {} }
  }));
  process.exit(0);
}

if (command === 'record') {
  const statePath = optionValue('--state-path');
  fs.mkdirSync(require('path').dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    last_run_at: '2026-03-09T00:30:00Z',
    discussion_refs: {}
  }));
  process.stdout.write('{}\\n');
  process.exit(0);
}

process.exit(1);
`,
        { mode: 0o755 },
      );

      const output = runLauncher();

      expect(output).toContain('Nightly improvement: noop');
      expect(fs.existsSync(path.join(tempDir, 'claude-args.txt'))).toBe(false);
      expect(
        fs.existsSync(
          path.join(
            sourceRoot,
            '.nanoclaw',
            'nightly-improvement',
            'state.json',
          ),
        ),
      ).toBe(true);
    },
  );
});
