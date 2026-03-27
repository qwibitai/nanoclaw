import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

describe('claw skill script', () => {
  it('exits zero after successful structured output even if the runtime is terminated', { timeout: 20000 }, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-skill-test-'));
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const runtimePath = path.join(binDir, 'container');
    fs.writeFileSync(
      runtimePath,
      `#!/bin/sh
cat >/dev/null
printf '%s\n' '---NANOCLAW_OUTPUT_START---' '{"status":"success","result":"4","newSessionId":"sess-1"}' '---NANOCLAW_OUTPUT_END---'
sleep 30
`,
    );
    fs.chmodSync(runtimePath, 0o755);

    const result = spawnSync(
      'python3',
      ['.claude/skills/claw/scripts/claw', '-j', 'tg:123', 'What is 2+2?'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NANOCLAW_DIR: tempDir,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
        timeout: 15000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('4');
    expect(result.stderr).toContain('[session: sess-1]');
  });
});
