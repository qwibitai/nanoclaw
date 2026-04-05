import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { syncSkills } from './skill-sync.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('syncSkills', () => {
  it('copies skill directories from src to dst', () => {
    const src = path.join(tmpDir, 'src');
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(path.join(src, 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(src, 'my-skill', 'SKILL.md'), '# My Skill');

    syncSkills(src, dst);

    expect(fs.existsSync(path.join(dst, 'my-skill', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'my-skill', 'SKILL.md'), 'utf8')).toBe('# My Skill');
  });

  it('skips files at the root (only copies directories)', () => {
    const src = path.join(tmpDir, 'src');
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'README.md'), 'not a skill');

    syncSkills(src, dst);

    expect(fs.existsSync(path.join(dst, 'README.md'))).toBe(false);
  });

  it('does nothing when src does not exist', () => {
    const dst = path.join(tmpDir, 'dst');
    syncSkills(path.join(tmpDir, 'nonexistent'), dst);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('overwrites existing skills in dst (group skills override built-in)', () => {
    const builtIn = path.join(tmpDir, 'builtin');
    const group = path.join(tmpDir, 'group');
    const dst = path.join(tmpDir, 'dst');

    // Built-in skill
    fs.mkdirSync(path.join(builtIn, 'status'), { recursive: true });
    fs.writeFileSync(path.join(builtIn, 'status', 'SKILL.md'), 'built-in');

    // Group override
    fs.mkdirSync(path.join(group, 'status'), { recursive: true });
    fs.writeFileSync(path.join(group, 'status', 'SKILL.md'), 'group override');

    syncSkills(builtIn, dst);
    syncSkills(group, dst);

    expect(fs.readFileSync(path.join(dst, 'status', 'SKILL.md'), 'utf8')).toBe('group override');
  });

  it('copies multiple skill directories', () => {
    const src = path.join(tmpDir, 'src');
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(path.join(src, 'skill-a'), { recursive: true });
    fs.mkdirSync(path.join(src, 'skill-b'), { recursive: true });
    fs.writeFileSync(path.join(src, 'skill-a', 'SKILL.md'), 'A');
    fs.writeFileSync(path.join(src, 'skill-b', 'SKILL.md'), 'B');

    syncSkills(src, dst);

    expect(fs.existsSync(path.join(dst, 'skill-a', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'skill-b', 'SKILL.md'))).toBe(true);
  });
});
