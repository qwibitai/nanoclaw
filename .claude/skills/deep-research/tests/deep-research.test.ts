import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('deep-research skill package', () => {
  const skillDir = path.resolve(__dirname, '..');
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const content = fs.readFileSync(skillMdPath, 'utf-8');

  it('has a valid SKILL.md with frontmatter', () => {
    expect(fs.existsSync(skillMdPath)).toBe(true);
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: deep-research');
    expect(content).toContain('description:');
  });

  it('description includes trigger keywords', () => {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/deep.research|research.report/i);
  });

  it('defines all 7 phases', () => {
    expect(content).toContain('## Phase 0');
    expect(content).toContain('## Phase 1');
    expect(content).toContain('## Phase 2');
    expect(content).toContain('## Phase 3');
    expect(content).toContain('## Phase 4');
    expect(content).toContain('## Phase 5');
    expect(content).toContain('## Phase 6');
    expect(content).toContain('## Phase 7');
  });

  it('requires minimum 200 sources', () => {
    expect(content).toContain('200');
  });

  it('requires minimum 400 line report', () => {
    expect(content).toContain('400');
  });

  it('includes citation QA phase', () => {
    expect(content).toMatch(/citation.qa|citation qa/i);
    expect(content).toContain('discrepanc');
  });

  it('includes 50% compression target', () => {
    expect(content).toContain('50%');
  });

  it('includes GitHub deployment instructions', () => {
    expect(content).toContain('git clone');
    expect(content).toContain('git commit');
    expect(content).toContain('git push');
  });

  it('includes troubleshooting section', () => {
    expect(content).toContain('## Troubleshooting');
  });

  it('is substantial enough to guide a full workflow', () => {
    const lines = content.split('\n').length;
    expect(lines).toBeGreaterThan(150);
  });
});
