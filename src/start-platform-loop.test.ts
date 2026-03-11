import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve('scripts/workflow/start-platform-loop.sh');

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('start-platform-loop launcher', () => {
  let tempDir: string;
  let binDir: string;
  let sourceRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-platform-loop-'));
    binDir = path.join(tempDir, 'bin');
    sourceRoot = path.join(tempDir, 'source-root');
    worktreePath = path.join(tempDir, 'worktree');

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
    writeExecutable(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop-sync.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\necho sync-ok\n',
    );
    writeExecutable(
      path.join(sourceRoot, 'scripts', 'workflow', 'autonomy-lane.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\necho {"paused":false}\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop.js'),
      'platform helper\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'scripts', 'workflow', 'nightly-improvement.js'),
      'nightly helper\n',
    );

    writeExecutable(
      path.join(binDir, 'git'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    );
    writeExecutable(
      path.join(binDir, 'gh'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    );
    writeExecutable(
      path.join(binDir, 'claude'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints a headless runner invocation in dry-run mode', () => {
    const output = execFileSync('bash', [SCRIPT_PATH, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT: sourceRoot,
        NANOCLAW_PLATFORM_LOOP_WORKTREE: worktreePath,
      },
    });

    expect(output).toContain('bash "');
    expect(output).toContain('run-platform-claude-session.sh');
    expect(output).toContain('--allowed-tools');
    expect(output).not.toContain('osascript');
  });
});
