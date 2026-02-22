import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'PERSISTENCE_ENABLED',
  'PERSISTENCE_ROOT',
  'PERSISTENCE_AUTO_RESUME_ON_BOOT',
  'PERSISTENCE_INCLUDE_PERSONALITY',
  'PERSISTENCE_SEED_MD_FILES',
] as const;

function backupEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function readTaskFile(root: string, group: string): string {
  return fs.readFileSync(path.join(root, group, 'task-progress.md'), 'utf8');
}

describe('persistent-state', () => {
  let tempRoot = '';
  const envSnapshot = backupEnv();

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.resetModules();
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  async function loadModule() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-persist-'));
    process.env.PERSISTENCE_ENABLED = 'true';
    process.env.PERSISTENCE_ROOT = tempRoot;
    process.env.PERSISTENCE_AUTO_RESUME_ON_BOOT = 'true';
    process.env.PERSISTENCE_INCLUDE_PERSONALITY = 'true';
    delete process.env.PERSISTENCE_SEED_MD_FILES;
    vi.resetModules();
    return import('./persistent-state.js');
  }

  it('creates task-progress file and embeds state metadata marker', async () => {
    const mod = await loadModule();
    mod.ensureGroupPersistenceFiles('group-a');
    const taskFile = readTaskFile(tempRoot, 'group-a');
    expect(taskFile).toContain('NANOCLAW_STATE');
    expect(taskFile).toContain('# Task Progress');
  });

  it('marks start/end transitions and controls boot resume flag', async () => {
    const mod = await loadModule();
    mod.ensureGroupPersistenceFiles('group-b');
    mod.markTaskRunStart('group-b', 'Investigate deployment incident', 'chat');

    expect(mod.shouldQueueBootResume('group-b')).toBe(true);
    const started = readTaskFile(tempRoot, 'group-b');
    expect(started).toContain('status: in_progress');
    expect(started).toContain('resume_on_boot: true');

    mod.markTaskRunEnd('group-b', 'success', 'Work complete', null);
    expect(mod.shouldQueueBootResume('group-b')).toBe(false);
    const finished = readTaskFile(tempRoot, 'group-b');
    expect(finished).toContain('status: idle');
    expect(finished).toContain('resume_on_boot: false');
  });

  it('injects personality and progress context into prompt', async () => {
    const mod = await loadModule();
    mod.ensureGroupPersistenceFiles('group-c');
    const paths = mod.getPersistencePaths('group-c');
    fs.writeFileSync(paths.personalityFile, '# Personality\nBe concise and direct.\n');

    const prompt = mod.buildPromptWithPersistence(
      '<messages><message>hello</message></messages>',
      'group-c',
    );

    expect(prompt).toContain('/workspace/persistence/task-progress.md');
    expect(prompt).toContain('/workspace/persistence/personality.md');
    expect(prompt).toContain('Be concise and direct.');
    expect(prompt).toContain('<messages><message>hello</message></messages>');
  });

  it('injects configured external markdown seed files into prompt', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-persist-'));
    const seedFile = path.join(tempRoot, 'seed-context.md');
    const ignoredFile = path.join(tempRoot, 'ignored.txt');
    fs.writeFileSync(seedFile, '# Seed Context\nUse project coding conventions.\n');
    fs.writeFileSync(ignoredFile, 'should not be included');

    process.env.PERSISTENCE_ENABLED = 'true';
    process.env.PERSISTENCE_ROOT = tempRoot;
    process.env.PERSISTENCE_AUTO_RESUME_ON_BOOT = 'true';
    process.env.PERSISTENCE_INCLUDE_PERSONALITY = 'true';
    process.env.PERSISTENCE_SEED_MD_FILES = `${seedFile},${ignoredFile}`;

    vi.resetModules();
    const mod = await import('./persistent-state.js');

    const prompt = mod.buildPromptWithPersistence(
      '<messages><message>hello</message></messages>',
      'group-seed',
    );

    expect(prompt).toContain('PERSISTENCE_SEED_MD_FILES');
    expect(prompt).toContain(seedFile);
    expect(prompt).toContain('Use project coding conventions.');
    expect(prompt).not.toContain(ignoredFile);
    expect(prompt).toContain('<messages><message>hello</message></messages>');
  });

  it('marks boot resume as queued to avoid repeating forever', async () => {
    const mod = await loadModule();
    mod.ensureGroupPersistenceFiles('group-d');
    mod.markTaskRunStart('group-d', 'Long running task', 'scheduled');
    expect(mod.shouldQueueBootResume('group-d')).toBe(true);

    mod.markBootResumeQueued('group-d');
    expect(mod.shouldQueueBootResume('group-d')).toBe(false);
    const file = readTaskFile(tempRoot, 'group-d');
    expect(file).toContain('status: resuming');
    expect(file).toContain('resume_on_boot: false');
  });
});
