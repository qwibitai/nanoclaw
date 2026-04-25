import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helperPath = path.resolve('setup/lib/channels-remote.sh');

function runBash(cwd: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return execFileSync('bash', ['-lc', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('channels remote resolver', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-channels-remote-'));
    runBash(tempDir, 'git init -q');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('selects a canonical upstream remote instead of a fork origin', () => {
    runBash(
      tempDir,
      [
        'git remote add origin https://github.com/example/nanoclaw-fork.git',
        'git remote add upstream https://github.com/qwibitai/nanoclaw.git',
      ].join(' && '),
    );

    const out = runBash(tempDir, `source ${helperPath}; resolve_channels_remote`);

    expect(out.trim()).toBe('upstream');
  });

  it('does not trust substring-matched remote URLs', () => {
    runBash(
      tempDir,
      'git remote add origin https://github.com/attacker/qwibitai-nanoclaw-mirror.git',
    );

    const out = runBash(tempDir, `source ${helperPath}; resolve_channels_remote`);
    const upstreamUrl = runBash(tempDir, 'git remote get-url upstream');

    expect(out.trim()).toBe('upstream');
    expect(upstreamUrl.trim()).toBe('https://github.com/qwibitai/nanoclaw.git');
  });

  it('rejects an override remote when its URL is not canonical', () => {
    runBash(tempDir, 'git remote add evil https://github.com/attacker/qwibitai-nanoclaw.git');

    expect(() =>
      runBash(tempDir, `source ${helperPath}; resolve_channels_remote`, {
        NANOCLAW_CHANNELS_REMOTE: 'evil',
      }),
    ).toThrow();
  });

  it('rejects unsafe override remote names before git fetch sees them', () => {
    expect(() =>
      runBash(tempDir, `source ${helperPath}; resolve_channels_remote`, {
        NANOCLAW_CHANNELS_REMOTE: '--upload-pack=touch-pwned',
      }),
    ).toThrow();
  });

  it('fails closed when an existing upstream remote is untrusted', () => {
    runBash(tempDir, 'git remote add upstream https://github.com/attacker/nanoclaw.git');

    expect(() => runBash(tempDir, `source ${helperPath}; resolve_channels_remote`)).toThrow();
  });
});
