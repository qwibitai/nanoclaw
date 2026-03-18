import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateCatalog } from './generate-catalog.js';

function setupTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('generateCatalog', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestDir();
  });

  afterEach(() => {
    cleanup(testDir);
  });

  test('generates catalog from local skill with frontmatter', () => {
    const skillDir = path.join(testDir, 'local', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\n# My Skill\n',
    );

    const categories = { defaults: ['general'], overrides: {} };
    const catalog = generateCatalog(testDir, categories);

    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toEqual({
      name: 'my-skill',
      source: 'local',
      description: 'A test skill',
      categories: ['general'],
      path: '/skills-catalog/local/my-skill',
    });
  });

  test('uses directory name when frontmatter missing', () => {
    const skillDir = path.join(testDir, 'local', 'fallback-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# No frontmatter\n');

    const categories = { defaults: ['general'], overrides: {} };
    const catalog = generateCatalog(testDir, categories);

    expect(catalog.skills[0].name).toBe('fallback-skill');
    expect(catalog.skills[0].description).toBe('');
  });

  test('applies category overrides', () => {
    const skillDir = path.join(testDir, 'local', 'openscad');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: openscad\ndescription: 3D modeling\n---\n',
    );

    const categories = {
      defaults: ['general'],
      overrides: { openscad: ['coding', 'engineering'] },
    };
    const catalog = generateCatalog(testDir, categories);

    expect(catalog.skills[0].categories).toEqual(['coding', 'engineering']);
  });

  test('handles nested multi-skill packages', () => {
    const base = path.join(testDir, 'local', 'materials-simulation-skills', 'skills');
    const skill1 = path.join(base, 'core-numerical', 'convergence-study');
    const skill2 = path.join(base, 'ontology', 'ontology-mapper');
    fs.mkdirSync(skill1, { recursive: true });
    fs.mkdirSync(skill2, { recursive: true });
    fs.writeFileSync(
      path.join(skill1, 'SKILL.md'),
      '---\nname: convergence-study\ndescription: Convergence analysis\n---\n',
    );
    fs.writeFileSync(
      path.join(skill2, 'SKILL.md'),
      '---\nname: ontology-mapper\ndescription: Map ontologies\n---\n',
    );

    const categories = { defaults: ['general'], overrides: {} };
    const catalog = generateCatalog(testDir, categories);

    expect(catalog.skills).toHaveLength(2);
    const names = catalog.skills.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['convergence-study', 'ontology-mapper']);
  });

  test('handles marketplace plugins', () => {
    const skillDir = path.join(testDir, 'plugins', 'superpowers', 'brainstorming');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: brainstorming\ndescription: Explore ideas\n---\n',
    );

    const categories = {
      defaults: ['general'],
      overrides: { brainstorming: ['coding', 'creative'] },
    };
    const catalog = generateCatalog(testDir, categories);

    expect(catalog.skills[0].source).toBe('plugin:superpowers');
    expect(catalog.skills[0].categories).toEqual(['coding', 'creative']);
    expect(catalog.skills[0].path).toBe(
      '/skills-catalog/plugins/superpowers/brainstorming',
    );
  });

  test('produces empty catalog when no skills exist', () => {
    fs.mkdirSync(path.join(testDir, 'local'), { recursive: true });
    const categories = { defaults: ['general'], overrides: {} };
    const catalog = generateCatalog(testDir, categories);
    expect(catalog.skills).toEqual([]);
  });
});
