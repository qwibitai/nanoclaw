/**
 * Tests for the add-lore-context skill.
 *
 * Validates that the skill files are well-formed and follow NanoClaw conventions.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SKILL_DIR = path.resolve(__dirname, '..');
const CONTAINER_SKILL_DIR = path.resolve(SKILL_DIR, '../../../container/skills/lore-context');

describe('add-lore-context skill', () => {
  describe('host skill (SKILL.md)', () => {
    it('exists', () => {
      const skillPath = path.join(SKILL_DIR, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it('has valid frontmatter with name and description', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/name:\s*add-lore-context/);
      expect(content).toMatch(/description:\s*.+/);
    });

    it('is under 500 lines', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
      const lineCount = content.split('\n').length;
      expect(lineCount).toBeLessThan(500);
    });

    it('references the container skill', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toContain('lore-context');
    });

    it('includes MCP server configuration', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toContain('mcpServers');
      expect(content).toContain('@lore-context/mcp-server');
    });

    it('includes credential setup instructions', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toContain('LORE_API_KEY');
    });
  });

  describe('container skill (SKILL.md)', () => {
    it('exists', () => {
      const skillPath = path.join(CONTAINER_SKILL_DIR, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it('has valid frontmatter with name and description', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/name:\s*lore-context/);
      expect(content).toMatch(/description:\s*.+/);
    });

    it('is under 500 lines', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      const lineCount = content.split('\n').length;
      expect(lineCount).toBeLessThan(500);
    });

    it('has allowed-tools frontmatter', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toMatch(/allowed-tools:/);
    });

    it('documents memory_search tool', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toContain('memory_search');
    });

    it('documents memory_write tool', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toContain('memory_write');
    });

    it('includes guidance on when to search', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toMatch(/when to use/i);
    });

    it('includes best practices', () => {
      const content = fs.readFileSync(path.join(CONTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
      expect(content).toMatch(/best practices/i);
    });
  });

  describe('MCP_CONFIG.md', () => {
    it('exists', () => {
      const configPath = path.join(SKILL_DIR, 'MCP_CONFIG.md');
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it('contains valid MCP server JSON example', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'MCP_CONFIG.md'), 'utf-8');
      expect(content).toContain('"mcpServers"');
      expect(content).toContain('"lore-context"');
      expect(content).toContain('"command"');
      expect(content).toContain('"args"');
    });

    it('documents environment variables', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'MCP_CONFIG.md'), 'utf-8');
      expect(content).toContain('LORE_API_KEY');
      expect(content).toContain('LORE_PROJECT_ID');
    });

    it('documents available MCP tools', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'MCP_CONFIG.md'), 'utf-8');
      expect(content).toContain('memory_search');
      expect(content).toContain('memory_write');
      expect(content).toContain('context_query');
    });
  });
});
