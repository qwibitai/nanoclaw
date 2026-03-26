import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

// Resolve the claw script from the marketplace plugin cache or local .claude/skills/
function findClawScript(): string | null {
  // Check local path first (pre-marketplace installs)
  const localPath = path.join(
    process.cwd(),
    '.claude/skills/claw/scripts/claw',
  );
  if (fs.existsSync(localPath)) return localPath;

  // Check marketplace plugin cache
  const cacheBase = path.join(
    os.homedir(),
    '.claude/plugins/cache/nanoclaw-skills/nanoclaw-skills',
  );
  if (fs.existsSync(cacheBase)) {
    const versions = fs
      .readdirSync(cacheBase)
      .filter((d) => fs.statSync(path.join(cacheBase, d)).isDirectory());
    if (versions.length > 0) {
      const cached = path.join(
        cacheBase,
        versions[0],
        'skills/claw/scripts/claw',
      );
      if (fs.existsSync(cached)) return cached;
    }
  }

  return null;
}

describe('claw skill script', () => {
  it('exits zero after successful structured output even if the runtime is terminated', () => {
    const clawScript = findClawScript();
    if (!clawScript) {
      // claw script lives in the nanoclaw-skills marketplace plugin — skip if not installed
      return;
    }
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
      [clawScript, '-j', 'tg:123', 'What is 2+2?'],
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
