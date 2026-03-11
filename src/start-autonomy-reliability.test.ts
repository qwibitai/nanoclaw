import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve('scripts/workflow/start-autonomy-reliability.sh');

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('start-autonomy-reliability launcher', () => {
  let tempDir: string;
  let binDir: string;
  let sourceRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-reliability-'));
    binDir = path.join(tempDir, 'bin');
    sourceRoot = path.join(tempDir, 'source-root');
    worktreePath = path.join(tempDir, 'worktree');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'scripts', 'workflow'), {
      recursive: true,
    });

    writeExecutable(
      path.join(sourceRoot, 'scripts', 'workflow', 'platform-loop-sync.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\necho sync-ok\n',
    );
    writeExecutable(
      path.join(sourceRoot, 'scripts', 'workflow', 'autonomy-lane.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\necho {"paused":false}\n',
    );
    writeExecutable(
      path.join(binDir, 'claude'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints a headless reliability runner invocation in dry-run mode', () => {
    const output = execFileSync('bash', [SCRIPT_PATH, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT: sourceRoot,
        NANOCLAW_RELIABILITY_WORKTREE: worktreePath,
      },
      cwd: sourceRoot,
    });

    expect(output).toContain('run-platform-claude-session.sh');
    expect(output).toContain('--allowed-tools');
    expect(output).toContain('reliability-loop');
  });
});
