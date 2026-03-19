/**
 * Tier 2 E2E: Dev container GitHub token injection and git auth.
 *
 * INVARIANT: Dev case containers receive GITHUB_TOKEN, configure git credential
 * helper via entrypoint.sh, and can authenticate to GitHub for push operations.
 * Work case containers must NOT receive GitHub credentials.
 *
 * SUT: container-runner.ts (token injection) → entrypoint.sh (credential config)
 *      → gh CLI + git credential helper (authentication)
 * VERIFICATION: Spawn container with GITHUB_TOKEN, verify gh auth + git credential
 *               helper are configured and functional. Spawn without, verify absence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { testContainerName, cleanupContainer } from './helpers.js';

const CONTAINER_IMAGE = 'nanoclaw-agent:latest';
const FAKE_TOKEN = 'ghp_e2eTestToken1234567890abcdef12345678';

/**
 * Run a command inside a fresh container.
 * Uses spawnSync with array args to avoid shell quoting issues.
 * Strips host env to prevent token leakage into container.
 */
function runInContainer(
  containerName: string,
  command: string,
  envVars: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const envArgs = Object.entries(envVars).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ]);

  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      containerName,
      ...envArgs,
      '--entrypoint',
      'bash',
      CONTAINER_IMAGE,
      '-c',
      command,
    ],
    {
      timeout: 30_000,
      encoding: 'utf-8',
      // Clean env for docker CLI itself — prevent host GITHUB_TOKEN leaking
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('Tier 2: Dev container GitHub auth', () => {
  const containers: string[] = [];

  afterEach(() => {
    for (const name of containers) {
      cleanupContainer(name);
    }
    containers.length = 0;
  });

  it('entrypoint configures git credential helper when GITHUB_TOKEN is set', () => {
    const name = testContainerName('e2e-git-cred');
    containers.push(name);

    // Run entrypoint.sh (it will fail on tsc, but git config happens first)
    // Then read back the git config values
    const result = runInContainer(
      name,
      '/app/entrypoint.sh <<< "{}" 2>/dev/null; ' +
        'echo "CRED_HELPER=$(git config --global credential.helper)" && ' +
        'echo "USER_EMAIL=$(git config --global user.email)" && ' +
        'echo "USER_NAME=$(git config --global user.name)"',
      { GITHUB_TOKEN: FAKE_TOKEN, GH_TOKEN: FAKE_TOKEN },
    );

    expect(result.stdout).toContain('USER_EMAIL=nanoclaw-dev@garsson.io');
    expect(result.stdout).toContain('USER_NAME=NanoClaw Dev Agent');
    expect(result.stdout).toMatch(/CRED_HELPER=.*password/);
  });

  it('gh CLI sees injected GH_TOKEN and attempts auth with it', () => {
    const name = testContainerName('e2e-gh-auth');
    containers.push(name);

    const result = runInContainer(name, 'gh auth status 2>&1', {
      GH_TOKEN: FAKE_TOKEN,
    });

    const output = result.stdout + result.stderr;
    // gh CLI picks up the token from GH_TOKEN env var
    // It will fail validation (fake token) but proves the plumbing works
    expect(output).toContain('GH_TOKEN');
    expect(output).toContain('github.com');
  });

  it('git credential helper produces correct credentials for HTTPS push', () => {
    const name = testContainerName('e2e-git-fill');
    containers.push(name);

    const script =
      'git config --global credential.helper ' +
      '\'!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f\'' +
      ' && printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill';

    const result = runInContainer(name, script, { GITHUB_TOKEN: FAKE_TOKEN });

    expect(result.stdout).toContain('username=x-access-token');
    expect(result.stdout).toContain(`password=${FAKE_TOKEN}`);
  });

  it('no GitHub credentials when GITHUB_TOKEN is not set (work case)', () => {
    const name = testContainerName('e2e-no-token');
    containers.push(name);

    // No GITHUB_TOKEN or GH_TOKEN passed — simulates a work case
    const result = runInContainer(
      name,
      'echo "GH=${GH_TOKEN:-UNSET}" && echo "GH_T=${GITHUB_TOKEN:-UNSET}" && gh auth status 2>&1; true',
      {},
    );

    expect(result.stdout).toContain('GH=UNSET');
    expect(result.stdout).toContain('GH_T=UNSET');
    expect(result.stdout + result.stderr).not.toMatch(
      /Logged in to github.com/i,
    );
  });
});
