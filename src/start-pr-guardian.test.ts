import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve('scripts/workflow/start-pr-guardian.sh');

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('start-pr-guardian launcher', () => {
  let tempDir: string;
  let binDir: string;
  let sourceRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-pr-guardian-'));
    binDir = path.join(tempDir, 'bin');
    sourceRoot = path.join(tempDir, 'source-root');

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
    fs.writeFileSync(
      path.join(
        sourceRoot,
        'scripts',
        'workflow',
        'autonomy-pr-guardian-output-schema.json',
      ),
      '{}\n',
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
      path.join(binDir, 'codex'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    );
    writeExecutable(
      path.join(binDir, 'python3'),
      '#!/usr/bin/env bash\nexec /usr/bin/python3 "$@"\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints a codex exec invocation in dry-run mode', () => {
    const output = execFileSync('bash', [SCRIPT_PATH, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        NANOCLAW_PR_GUARDIAN_WORKTREE: path.join(tempDir, 'worktree'),
        NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT: sourceRoot,
      },
      cwd: sourceRoot,
    });

    expect(output).toContain('codex');
    expect(output).toContain('exec --ephemeral --json -p "pr_guardian"');
    expect(output).toContain('--output-schema');
  });
});

