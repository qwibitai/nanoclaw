import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { CodexProvider, composeAvailableSkills, resolveClaudeImports } from './codex.js';

describe('createProvider (codex)', () => {
  it('returns CodexProvider for codex', () => {
    expect(createProvider('codex')).toBeInstanceOf(CodexProvider);
  });

  it('flags stale thread errors as session-invalid', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('thread not found'))).toBe(true);
    expect(p.isSessionInvalid(new Error('unknown thread 123'))).toBe(true);
    expect(p.isSessionInvalid(new Error('No such thread: abc'))).toBe(true);
  });

  it('does not flag unrelated errors as session-invalid', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('rate limit exceeded'))).toBe(false);
    expect(p.isSessionInvalid(new Error('connection reset'))).toBe(false);
    expect(p.isSessionInvalid(new Error('codex app-server exited: code=1'))).toBe(false);
  });

  it('declares no native slash command support', () => {
    const p = new CodexProvider();
    expect(p.supportsNativeSlashCommands).toBe(false);
  });
});

describe('resolveClaudeImports', () => {
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-imports-'));
  }

  it('inlines a single relative import', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'fragment.md'), 'FRAGMENT CONTENT');
    const resolved = resolveClaudeImports('before\n@./fragment.md\nafter', dir);
    expect(resolved).toContain('FRAGMENT CONTENT');
    expect(resolved).not.toContain('@./fragment.md');
    expect(resolved).toMatch(/before[\s\S]*FRAGMENT CONTENT[\s\S]*after/);
  });

  it('expands nested imports relative to the parent file', () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'INNER');
    fs.writeFileSync(path.join(dir, 'sub', 'outer.md'), '@./inner.md');
    const resolved = resolveClaudeImports('@./sub/outer.md', dir);
    expect(resolved).toBe('INNER');
  });

  it('drops missing imports to empty text rather than leaving raw @path', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('before\n@./does-not-exist.md\nafter', dir);
    expect(resolved).not.toContain('@./does-not-exist.md');
    expect(resolved).toContain('before');
    expect(resolved).toContain('after');
  });

  it('breaks cycles', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), '@./a.md');
    // Just needs to terminate without a stack overflow.
    const resolved = resolveClaudeImports('@./a.md', dir);
    expect(typeof resolved).toBe('string');
  });

  it('leaves non-import @ mentions alone (only line-anchored @<path> is imported)', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('email @someone for details', dir);
    expect(resolved).toBe('email @someone for details');
  });
});

describe('composeAvailableSkills', () => {
  function makeSkillsDir(skills: { name: string; frontmatter?: string; body?: string }[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    for (const s of skills) {
      const skillDir = path.join(dir, s.name);
      fs.mkdirSync(skillDir, { recursive: true });
      const body = s.body ?? '# Body';
      const content = s.frontmatter ? `---\n${s.frontmatter}\n---\n${body}` : body;
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
    return dir;
  }

  it('returns undefined when no skills dir exists', () => {
    expect(composeAvailableSkills(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()))).toBeUndefined();
  });

  it('lists each skill with name + description from frontmatter', () => {
    const dir = makeSkillsDir([
      { name: 'make-website', frontmatter: 'name: make-website\ndescription: Build and publish a website.' },
      { name: 'wiki', frontmatter: 'name: wiki\ndescription: Maintain a persistent wiki.' },
    ]);
    const out = composeAvailableSkills(dir)!;
    expect(out).toContain('# Available skills');
    expect(out).toContain('**make-website** — Build and publish a website.');
    expect(out).toContain('**wiki** — Maintain a persistent wiki.');
    expect(out).toContain('/app/skills/<name>/SKILL.md');
  });

  it('skips a skill without a description', () => {
    const dir = makeSkillsDir([
      { name: 'good', frontmatter: 'name: good\ndescription: Has one.' },
      { name: 'no-desc', frontmatter: 'name: no-desc' },
      { name: 'no-frontmatter' },
    ]);
    const out = composeAvailableSkills(dir)!;
    expect(out).toContain('**good**');
    expect(out).not.toContain('no-desc');
    expect(out).not.toContain('no-frontmatter');
  });

  it('falls back to directory name when frontmatter omits the name field', () => {
    const dir = makeSkillsDir([{ name: 'fallback', frontmatter: 'description: Has description but no name field.' }]);
    const out = composeAvailableSkills(dir)!;
    expect(out).toContain('**fallback** — Has description but no name field.');
  });

  it('returns undefined when no skills have descriptions', () => {
    const dir = makeSkillsDir([{ name: 'naked', body: '# Just a body' }]);
    expect(composeAvailableSkills(dir)).toBeUndefined();
  });

  it('sorts skills deterministically (alphabetical by directory name)', () => {
    const dir = makeSkillsDir([
      { name: 'zulu', frontmatter: 'name: zulu\ndescription: Z.' },
      { name: 'alpha', frontmatter: 'name: alpha\ndescription: A.' },
      { name: 'mike', frontmatter: 'name: mike\ndescription: M.' },
    ]);
    const out = composeAvailableSkills(dir)!;
    const aIdx = out.indexOf('**alpha**');
    const mIdx = out.indexOf('**mike**');
    const zIdx = out.indexOf('**zulu**');
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });
});
