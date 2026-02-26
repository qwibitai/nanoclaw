import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  areRangesCompatible,
  mergeNpmDependencies,
  mergeEnvAdditions,
  mergeDockerComposeServices,
} from '../structured.js';
import { createTempDir, cleanup } from './test-helpers.js';

describe('structured', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  describe('areRangesCompatible', () => {
    it('identical versions are compatible', () => {
      const result = areRangesCompatible('^1.0.0', '^1.0.0');
      expect(result.compatible).toBe(true);
    });

    it('compatible ^ ranges resolve to higher', () => {
      const result = areRangesCompatible('^1.0.0', '^1.1.0');
      expect(result.compatible).toBe(true);
      expect(result.resolved).toBe('^1.1.0');
    });

    it('incompatible major ^ ranges', () => {
      const result = areRangesCompatible('^1.0.0', '^2.0.0');
      expect(result.compatible).toBe(false);
    });

    it('compatible ~ ranges', () => {
      const result = areRangesCompatible('~1.0.0', '~1.0.3');
      expect(result.compatible).toBe(true);
      expect(result.resolved).toBe('~1.0.3');
    });

    it('mismatched prefixes are incompatible', () => {
      const result = areRangesCompatible('^1.0.0', '~1.0.0');
      expect(result.compatible).toBe(false);
    });

    it('handles double-digit version parts numerically', () => {
      // ^1.9.0 vs ^1.10.0 — 10 > 9 numerically, but "9" > "10" as strings
      const result = areRangesCompatible('^1.9.0', '^1.10.0');
      expect(result.compatible).toBe(true);
      expect(result.resolved).toBe('^1.10.0');
    });

    it('handles double-digit patch versions', () => {
      const result = areRangesCompatible('~1.0.9', '~1.0.10');
      expect(result.compatible).toBe(true);
      expect(result.resolved).toBe('~1.0.10');
    });
  });

  describe('mergeNpmDependencies', () => {
    it('adds new dependencies', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'test',
            dependencies: { existing: '^1.0.0' },
          },
          null,
          2,
        ),
      );

      mergeNpmDependencies(pkgPath, { newdep: '^2.0.0' });

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      expect(pkg.dependencies.newdep).toBe('^2.0.0');
      expect(pkg.dependencies.existing).toBe('^1.0.0');
    });

    it('resolves compatible ^ ranges', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'test',
            dependencies: { dep: '^1.0.0' },
          },
          null,
          2,
        ),
      );

      mergeNpmDependencies(pkgPath, { dep: '^1.1.0' });

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      expect(pkg.dependencies.dep).toBe('^1.1.0');
    });

    it('sorts devDependencies after merge', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'test',
            dependencies: {},
            devDependencies: { zlib: '^1.0.0', acorn: '^2.0.0' },
          },
          null,
          2,
        ),
      );

      mergeNpmDependencies(pkgPath, { middle: '^1.0.0' });

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const devKeys = Object.keys(pkg.devDependencies);
      expect(devKeys).toEqual(['acorn', 'zlib']);
    });

    it('throws on incompatible major versions', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'test',
            dependencies: { dep: '^1.0.0' },
          },
          null,
          2,
        ),
      );

      expect(() => mergeNpmDependencies(pkgPath, { dep: '^2.0.0' })).toThrow();
    });
  });

  describe('mergeEnvAdditions', () => {
    it('adds new variables', () => {
      const envPath = path.join(tmpDir, '.env.example');
      fs.writeFileSync(envPath, 'EXISTING_VAR=value\n');

      mergeEnvAdditions(envPath, ['NEW_VAR']);

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('NEW_VAR=');
      expect(content).toContain('EXISTING_VAR=value');
    });

    it('skips existing variables', () => {
      const envPath = path.join(tmpDir, '.env.example');
      fs.writeFileSync(envPath, 'MY_VAR=original\n');

      mergeEnvAdditions(envPath, ['MY_VAR']);

      const content = fs.readFileSync(envPath, 'utf-8');
      // Should not add duplicate - only 1 occurrence of MY_VAR=
      const matches = content.match(/MY_VAR=/g);
      expect(matches).toHaveLength(1);
    });

    it('recognizes lowercase and mixed-case env vars as existing', () => {
      const envPath = path.join(tmpDir, '.env.example');
      fs.writeFileSync(envPath, 'my_lower_var=value\nMixed_Case=abc\n');

      mergeEnvAdditions(envPath, ['my_lower_var', 'Mixed_Case']);

      const content = fs.readFileSync(envPath, 'utf-8');
      // Should not add duplicates
      const lowerMatches = content.match(/my_lower_var=/g);
      expect(lowerMatches).toHaveLength(1);
      const mixedMatches = content.match(/Mixed_Case=/g);
      expect(mixedMatches).toHaveLength(1);
    });

    it('creates file if it does not exist', () => {
      const envPath = path.join(tmpDir, '.env.example');
      mergeEnvAdditions(envPath, ['NEW_VAR']);

      expect(fs.existsSync(envPath)).toBe(true);
      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('NEW_VAR=');
    });
  });

  describe('mergeDockerComposeServices', () => {
    it('adds new services', () => {
      const composePath = path.join(tmpDir, 'docker-compose.yaml');
      fs.writeFileSync(
        composePath,
        'version: "3"\nservices:\n  web:\n    image: nginx\n',
      );

      mergeDockerComposeServices(composePath, {
        redis: { image: 'redis:7' },
      });

      const content = fs.readFileSync(composePath, 'utf-8');
      expect(content).toContain('redis');
    });

    it('skips existing services', () => {
      const composePath = path.join(tmpDir, 'docker-compose.yaml');
      fs.writeFileSync(
        composePath,
        'version: "3"\nservices:\n  web:\n    image: nginx\n',
      );

      mergeDockerComposeServices(composePath, {
        web: { image: 'apache' },
      });

      const content = fs.readFileSync(composePath, 'utf-8');
      expect(content).toContain('nginx');
    });

    it('throws on port collision', () => {
      const composePath = path.join(tmpDir, 'docker-compose.yaml');
      fs.writeFileSync(
        composePath,
        'version: "3"\nservices:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n',
      );

      expect(() =>
        mergeDockerComposeServices(composePath, {
          api: { image: 'node', ports: ['8080:3000'] },
        }),
      ).toThrow();
    });
  });
});
