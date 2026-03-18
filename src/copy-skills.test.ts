import { describe, test, expect } from 'vitest';
import { copySkillsForGroup } from './container-runner.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('copySkillsForGroup', () => {
  test('copies only skills matching group categories', () => {
    const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));

    const skill1Dir = path.join(catalogDir, 'local', 'agent-browser');
    const skill2Dir = path.join(catalogDir, 'plugins', 'superpowers', 'tdd');
    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });
    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Browser');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# TDD');

    fs.writeFileSync(
      path.join(catalogDir, 'catalog.json'),
      JSON.stringify({
        skills: [
          { name: 'agent-browser', categories: ['coding', 'general'], path: '/skills-catalog/local/agent-browser' },
          { name: 'tdd', categories: ['coding'], path: '/skills-catalog/plugins/superpowers/tdd' },
        ],
      }),
    );

    // Copy with ["general"] — should only get agent-browser
    copySkillsForGroup(catalogDir, destDir, ['general']);
    expect(fs.existsSync(path.join(destDir, 'agent-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'tdd', 'SKILL.md'))).toBe(false);

    fs.rmSync(catalogDir, { recursive: true });
    fs.rmSync(destDir, { recursive: true });
  });

  test('copies all matching skills when group has multiple categories', () => {
    const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));

    const skill1Dir = path.join(catalogDir, 'local', 'agent-browser');
    const skill2Dir = path.join(catalogDir, 'plugins', 'superpowers', 'tdd');
    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });
    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Browser');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# TDD');

    fs.writeFileSync(
      path.join(catalogDir, 'catalog.json'),
      JSON.stringify({
        skills: [
          { name: 'agent-browser', categories: ['coding', 'general'], path: '/skills-catalog/local/agent-browser' },
          { name: 'tdd', categories: ['coding'], path: '/skills-catalog/plugins/superpowers/tdd' },
        ],
      }),
    );

    copySkillsForGroup(catalogDir, destDir, ['coding']);
    expect(fs.existsSync(path.join(destDir, 'agent-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'tdd', 'SKILL.md'))).toBe(true);

    fs.rmSync(catalogDir, { recursive: true });
    fs.rmSync(destDir, { recursive: true });
  });

  test('falls back to copying all local skills when no catalog.json exists', () => {
    const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));

    const skillDir = path.join(catalogDir, 'local', 'agent-browser');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Browser');

    copySkillsForGroup(catalogDir, destDir, ['general']);
    expect(fs.existsSync(path.join(destDir, 'agent-browser', 'SKILL.md'))).toBe(true);

    fs.rmSync(catalogDir, { recursive: true });
    fs.rmSync(destDir, { recursive: true });
  });
});
