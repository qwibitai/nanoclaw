import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('slack skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: slack');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@slack/bolt');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.ts');
    const addTestFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.test.ts');
    expect(fs.existsSync(addFile)).toBe(true);
    expect(fs.existsSync(addTestFile)).toBe(true);
  });

  it('has all files declared in modifies', () => {
    const required = [
      'modify/src/index.ts',
      'modify/src/config.ts',
      'modify/src/group-queue.ts',
      'modify/src/types.ts',
      'modify/src/routing.test.ts',
      'modify/package.json',
      'modify/.env.example',
    ];
    for (const rel of required) {
      expect(fs.existsSync(path.join(skillDir, rel))).toBe(true);
    }
  });

  it('includes slack manifest and scripts', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'references', 'slack-app-manifest.yaml')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'scripts', 'apply-slack-mvp.sh')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'scripts', 'verify-slack-mvp.sh')),
    ).toBe(true);
  });
});
