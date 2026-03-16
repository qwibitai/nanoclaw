import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-memos skill package', () => {
  describe('manifest.yaml', () => {
    it('has a valid manifest', () => {
      const manifestPath = path.join(SKILL_DIR, 'manifest.yaml');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('skill: memos');
      expect(content).toContain('version: 1.0.0');
    });

    it('declares no npm dependencies', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'manifest.yaml'),
        'utf-8',
      );
      expect(content).toContain('npm_dependencies: {}');
    });
  });

  describe('add/ files', () => {
    it('has memos-client.ts with searchMemories and addMemory', () => {
      const filePath = path.join(SKILL_DIR, 'add/src/memos-client.ts');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('searchMemories');
      expect(content).toContain('addMemory');
    });

    it('has memos-mcp-stdio.ts with MCP tools', () => {
      const filePath = path.join(
        SKILL_DIR,
        'add/container/agent-runner/src/memos-mcp-stdio.ts',
      );
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('search_memories');
      expect(content).toContain('add_memory');
      expect(content).toContain('chat');
    });

    it('has migration script', () => {
      const filePath = path.join(
        SKILL_DIR,
        'add/scripts/migrate-memories-to-memos.ts',
      );
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('modify/ files', () => {
    const modifyFiles = [
      'src/config.ts',
      'src/index.ts',
      'src/container-runner.ts',
      'container/agent-runner/src/index.ts',
      '.env.example',
    ];

    for (const file of modifyFiles) {
      it(`has ${file} with intent.md`, () => {
        const snapshotPath = path.join(SKILL_DIR, 'modify', file);
        const intentPath = path.join(SKILL_DIR, 'modify', `${file}.intent.md`);
        expect(fs.existsSync(snapshotPath)).toBe(true);
        expect(fs.existsSync(intentPath)).toBe(true);
      });
    }

    it('config.ts contains MEMOS_API_URL and MEMOS_USER_ID', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify/src/config.ts'),
        'utf-8',
      );
      expect(content).toContain('MEMOS_API_URL');
      expect(content).toContain('MEMOS_USER_ID');
      expect(content).toContain('CONTAINER_NETWORK');
    });

    it('index.ts contains auto-recall and auto-capture', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify/src/index.ts'),
        'utf-8',
      );
      expect(content).toContain('searchMemories');
      expect(content).toContain('addMemory');
      expect(content).toContain('responseChunks');
    });

    it('container-runner.ts contains network and secrets handling', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify/src/container-runner.ts'),
        'utf-8',
      );
      expect(content).toContain('CONTAINER_NETWORK');
      expect(content).toContain('MEMOS_CONTAINER_API_URL');
      expect(content).toContain('readSecrets');
    });

    it('agent-runner index.ts contains conditional memos MCP server', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify/container/agent-runner/src/index.ts'),
        'utf-8',
      );
      expect(content).toContain("mcp__memos__*");
      expect(content).toContain('memosConfig');
      expect(content).toContain('memos-mcp-stdio');
    });

    it('.env.example contains MemOS variables', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify/.env.example'),
        'utf-8',
      );
      expect(content).toContain('MEMOS_API_URL');
      expect(content).toContain('MEMOS_API_AUTH');
      expect(content).toContain('MEMOS_CONTAINER_API_URL');
      expect(content).toContain('CONTAINER_NETWORK');
    });
  });

  describe('SKILL.md', () => {
    it('exists with proper frontmatter', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'SKILL.md'),
        'utf-8',
      );
      expect(content).toContain('name: add-memos');
      expect(content).toContain('Phase 1: Pre-flight');
      expect(content).toContain('Phase 2: Apply Code Changes');
      expect(content).toContain('Troubleshooting');
    });
  });
});
