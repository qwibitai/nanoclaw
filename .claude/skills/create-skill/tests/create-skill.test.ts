import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('create-skill meta-skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with correct frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);

    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: create-skill');
    expect(content).toContain('description:');
  });

  it('SKILL.md contains all required phases', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('## Phase 1: Inspect Fork State');
    expect(content).toContain('## Phase 2: Interview');
    expect(content).toContain('## Phase 3: Generate the Skill Package');
    expect(content).toContain('## Phase 4: Test');
    expect(content).toContain('## Phase 5: Upstream PR (Optional)');
    expect(content).toContain('## Troubleshooting');
    expect(content).toContain('## Reference');
  });

  it('SKILL.md covers both skill types', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('Code modification skill');
    expect(content).toContain('Interactive skill');
  });

  it('SKILL.md references the skills engine correctly', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('skills-engine/types.ts');
    expect(content).toContain('skills-engine/manifest.ts');
    expect(content).toContain('scripts/apply-skill.ts');
    expect(content).toContain('.nanoclaw/state.yaml');
  });

  it('SKILL.md includes clean-base testing instructions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('Clean-base compatibility test');
    expect(content).toContain('git worktree');
  });

  it('has templates directory with all required templates', () => {
    const templatesDir = path.join(skillDir, 'templates');
    expect(fs.existsSync(templatesDir)).toBe(true);

    const expectedTemplates = [
      'SKILL.md.template',
      'manifest.yaml.template',
      'intent.md.template',
      'test.ts.template',
    ];

    for (const template of expectedTemplates) {
      const templatePath = path.join(templatesDir, template);
      expect(
        fs.existsSync(templatePath),
        `Template missing: ${template}`,
      ).toBe(true);

      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('SKILL.md.template has the 5-phase structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'SKILL.md.template'),
      'utf-8',
    );

    expect(content).toContain('## Phase 1: Pre-flight');
    expect(content).toContain('## Phase 2: Apply Code Changes');
    expect(content).toContain('## Phase 3: Setup');
    expect(content).toContain('## Phase 4: Registration');
    expect(content).toContain('## Phase 5: Verify');
    expect(content).toContain('## Troubleshooting');
  });

  it('manifest.yaml.template has all required fields', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'manifest.yaml.template'),
      'utf-8',
    );

    expect(content).toContain('skill:');
    expect(content).toContain('version:');
    expect(content).toContain('core_version:');
    expect(content).toContain('adds:');
    expect(content).toContain('modifies:');
    expect(content).toContain('conflicts:');
    expect(content).toContain('depends:');
    expect(content).toContain('test:');
  });

  it('intent.md.template has required sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'intent.md.template'),
      'utf-8',
    );

    expect(content).toContain('## What changed');
    expect(content).toContain('## Key sections');
    expect(content).toContain('## Invariants');
    expect(content).toContain('## Must-keep');
  });

  it('test.ts.template has vitest structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'test.ts.template'),
      'utf-8',
    );

    expect(content).toContain("import { describe, expect, it } from 'vitest'");
    expect(content).toContain('describe(');
    expect(content).toContain('manifest');
  });

  it('SKILL.md description includes trigger keywords', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();

    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toContain('create skill');
    expect(frontmatter).toContain('new skill');
    expect(frontmatter).toContain('build a skill');
  });

  it('references existing skills as examples', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('add-discord');
    expect(content).toContain('add-telegram');
    expect(content).toContain('setup');
    expect(content).toContain('customize');
  });
});
