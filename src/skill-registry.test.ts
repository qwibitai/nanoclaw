import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';

// Mock logger before importing the module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  scanSkills,
  getRegisteredSkills,
  getSkill,
  startSkillServer,
  _resetForTesting,
} from './skill-registry.js';

const TEST_DIR = path.join('/tmp', `nanoclaw-skill-test-${process.pid}`);

function writeSkill(name: string, frontMatter: string, body = ''): void {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontMatter}\n---\n\n${body}`,
  );
}

describe('skill-registry', () => {
  beforeEach(() => {
    _resetForTesting();
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    _resetForTesting();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('scanSkills', () => {
    it('registers skills from SKILL.md front-matter', () => {
      writeSkill(
        'test-skill',
        'name: test-skill\ndescription: A test skill\nallowed-tools: Bash(test:*)',
      );

      const count = scanSkills(TEST_DIR);
      expect(count).toBe(1);

      const skills = getRegisteredSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('test-skill');
      expect(skills[0].description).toBe('A test skill');
      expect(skills[0].allowedTools).toBe('Bash(test:*)');
      expect(skills[0].registeredAt).toBeTruthy();
    });

    it('registers multiple skills', () => {
      writeSkill('skill-a', 'name: skill-a\ndescription: Skill A');
      writeSkill('skill-b', 'name: skill-b\ndescription: Skill B');

      const count = scanSkills(TEST_DIR);
      expect(count).toBe(2);
      expect(getRegisteredSkills()).toHaveLength(2);
    });

    it('skips directories without SKILL.md', () => {
      fs.mkdirSync(path.join(TEST_DIR, 'empty-dir'), { recursive: true });
      writeSkill('valid', 'name: valid\ndescription: Valid');

      const count = scanSkills(TEST_DIR);
      expect(count).toBe(1);
    });

    it('skips SKILL.md without name field', () => {
      writeSkill('no-name', 'description: Missing name field');

      const count = scanSkills(TEST_DIR);
      expect(count).toBe(0);
      expect(getRegisteredSkills()).toHaveLength(0);
    });

    it('re-registers updated skills', () => {
      writeSkill('evolving', 'name: evolving\ndescription: Version 1');
      scanSkills(TEST_DIR);
      expect(getSkill('evolving')?.description).toBe('Version 1');

      writeSkill('evolving', 'name: evolving\ndescription: Version 2');
      scanSkills(TEST_DIR);
      expect(getSkill('evolving')?.description).toBe('Version 2');
    });

    it('returns 0 for non-existent directory', () => {
      const count = scanSkills('/tmp/does-not-exist-xyz');
      expect(count).toBe(0);
    });

    it('ignores non-directory entries', () => {
      fs.writeFileSync(path.join(TEST_DIR, 'README.md'), '# not a skill');
      writeSkill('real', 'name: real\ndescription: A real skill');

      const count = scanSkills(TEST_DIR);
      expect(count).toBe(1);
    });
  });

  describe('getSkill', () => {
    it('returns undefined for unregistered skill', () => {
      expect(getSkill('nonexistent')).toBeUndefined();
    });

    it('returns the skill entry by name', () => {
      writeSkill('lookup', 'name: lookup\ndescription: For lookup test');
      scanSkills(TEST_DIR);

      const skill = getSkill('lookup');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('lookup');
    });
  });

  describe('HTTP endpoint', () => {
    let server: http.Server;

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('GET /skills returns registered skills as JSON', async () => {
      writeSkill('http-test', 'name: http-test\ndescription: HTTP test skill');
      scanSkills(TEST_DIR);

      server = await startSkillServer(0, '127.0.0.1');
      const port = (server.address() as { port: number }).port;

      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/skills`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
          res.on('error', reject);
        });
      });

      const skills = JSON.parse(body);
      expect(Array.isArray(skills)).toBe(true);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('http-test');
      expect(skills[0].description).toBe('HTTP test skill');
      expect(skills[0].file).toBeTruthy();
      expect(skills[0].registeredAt).toBeTruthy();
      // allowedTools should not be in the HTTP response
      expect(skills[0].allowedTools).toBeUndefined();
    });

    it('returns 404 for other paths', async () => {
      server = await startSkillServer(0, '127.0.0.1');
      const port = (server.address() as { port: number }).port;

      const statusCode = await new Promise<number>((resolve) => {
        http.get(`http://127.0.0.1:${port}/other`, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
      });

      expect(statusCode).toBe(404);
    });
  });
});
