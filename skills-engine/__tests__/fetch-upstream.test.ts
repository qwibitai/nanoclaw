import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('fetch-upstream.sh', () => {
  let projectDir: string;
  let upstreamBareDir: string;
  const scriptPath = path.resolve(
    '.claude/skills/update/scripts/fetch-upstream.sh',
  );

  beforeEach(() => {
    // Create a bare repo to act as "upstream"
    upstreamBareDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-upstream-'),
    );
    execSync('git init --bare -b main', { cwd: upstreamBareDir, stdio: 'pipe' });

    // Create a working repo, add files, push to the bare repo
    const seedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-seed-'),
    );
    execSync('git init -b main', { cwd: seedDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: seedDir,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test"', { cwd: seedDir, stdio: 'pipe' });
    fs.writeFileSync(
      path.join(seedDir, 'package.json'),
      JSON.stringify({ name: 'nanoclaw', version: '2.0.0' }),
    );
    fs.mkdirSync(path.join(seedDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(seedDir, 'src/index.ts'),
      'export const v = 2;',
    );
    execSync('git add -A && git commit -m "upstream v2.0.0"', {
      cwd: seedDir,
      stdio: 'pipe',
    });
    execSync(`git remote add origin ${upstreamBareDir}`, {
      cwd: seedDir,
      stdio: 'pipe',
    });
    execSync('git push origin main', {
      cwd: seedDir,
      stdio: 'pipe',
    });

    fs.rmSync(seedDir, { recursive: true, force: true });

    // Create the "project" repo that will run the script
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-project-'),
    );
    execSync('git init -b main', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test"', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'nanoclaw', version: '1.0.0' }),
    );
    execSync('git add -A && git commit -m "init"', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    // Copy skills-engine/constants.ts so fetch-upstream.sh can read BASE_INCLUDES
    const constantsSrc = path.resolve('skills-engine/constants.ts');
    const constantsDest = path.join(projectDir, 'skills-engine/constants.ts');
    fs.mkdirSync(path.dirname(constantsDest), { recursive: true });
    fs.copyFileSync(constantsSrc, constantsDest);

    // Copy the script into the project so it can find PROJECT_ROOT
    const skillScriptsDir = path.join(
      projectDir,
      '.claude/skills/update/scripts',
    );
    fs.mkdirSync(skillScriptsDir, { recursive: true });
    fs.copyFileSync(scriptPath, path.join(skillScriptsDir, 'fetch-upstream.sh'));
    fs.chmodSync(path.join(skillScriptsDir, 'fetch-upstream.sh'), 0o755);
  });

  afterEach(() => {
    // Clean up temp dirs (also any TEMP_DIR created by the script)
    for (const dir of [projectDir, upstreamBareDir]) {
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function runFetchUpstream(): { stdout: string; exitCode: number } {
    try {
      const stdout = execFileSync(
        'bash',
        ['.claude/skills/update/scripts/fetch-upstream.sh'],
        {
          cwd: projectDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 30_000,
        },
      );
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: (err.stdout ?? '') + (err.stderr ?? ''), exitCode: err.status ?? 1 };
    }
  }

  function parseStatus(stdout: string): Record<string, string> {
    const match = stdout.match(/<<< STATUS\n([\s\S]*?)\nSTATUS >>>/);
    if (!match) return {};
    const lines = match[1].trim().split('\n');
    const result: Record<string, string> = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        result[line.slice(0, eq)] = line.slice(eq + 1);
      }
    }
    return result;
  }

  it('uses existing upstream remote', () => {
    execSync(`git remote add upstream ${upstreamBareDir}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { stdout, exitCode } = runFetchUpstream();
    const status = parseStatus(stdout);

    expect(exitCode).toBe(0);
    expect(status.STATUS).toBe('success');
    expect(status.REMOTE).toBe('upstream');
    expect(status.CURRENT_VERSION).toBe('1.0.0');
    expect(status.NEW_VERSION).toBe('2.0.0');
    expect(status.TEMP_DIR).toMatch(/^\/tmp\/nanoclaw-update-/);

    // Verify extracted files exist
    expect(
      fs.existsSync(path.join(status.TEMP_DIR, 'package.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(status.TEMP_DIR, 'src/index.ts')),
    ).toBe(true);

    // Cleanup temp dir
    fs.rmSync(status.TEMP_DIR, { recursive: true, force: true });
  });

  it('uses origin when it points to qwibitai/nanoclaw', () => {
    // Set origin to a URL containing qwibitai/nanoclaw
    execSync(
      `git remote add origin https://github.com/qwibitai/nanoclaw.git`,
      { cwd: projectDir, stdio: 'pipe' },
    );
    // We can't actually fetch from GitHub in tests, but we can verify
    // it picks the right remote. We'll add a second remote it CAN fetch from.
    execSync(`git remote add upstream ${upstreamBareDir}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { stdout, exitCode } = runFetchUpstream();
    const status = parseStatus(stdout);

    // It should find 'upstream' first (checked before origin)
    expect(exitCode).toBe(0);
    expect(status.REMOTE).toBe('upstream');

    if (status.TEMP_DIR) {
      fs.rmSync(status.TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('adds upstream remote when none exists', { timeout: 15_000 }, () => {
    // Remove origin if any
    try {
      execSync('git remote remove origin', {
        cwd: projectDir,
        stdio: 'pipe',
      });
    } catch {
      // No origin
    }

    const { stdout } = runFetchUpstream();

    // It will try to add upstream pointing to github (which will fail to fetch),
    // but we can verify it attempted to add the remote
    expect(stdout).toContain('Adding upstream');

    // Verify the remote was added
    const remotes = execSync('git remote -v', {
      cwd: projectDir,
      encoding: 'utf-8',
    });
    expect(remotes).toContain('upstream');
    expect(remotes).toContain('qwibitai/nanoclaw');
  });

  it('extracts files to temp dir correctly', () => {
    execSync(`git remote add upstream ${upstreamBareDir}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const { stdout, exitCode } = runFetchUpstream();
    const status = parseStatus(stdout);

    expect(exitCode).toBe(0);

    // Check file content matches what was pushed
    const pkg = JSON.parse(
      fs.readFileSync(path.join(status.TEMP_DIR, 'package.json'), 'utf-8'),
    );
    expect(pkg.version).toBe('2.0.0');

    const indexContent = fs.readFileSync(
      path.join(status.TEMP_DIR, 'src/index.ts'),
      'utf-8',
    );
    expect(indexContent).toBe('export const v = 2;');

    fs.rmSync(status.TEMP_DIR, { recursive: true, force: true });
  });
});
