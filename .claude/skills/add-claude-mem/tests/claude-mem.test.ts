import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// These tests validate the claude-mem integration points.
// They run against the actual source files (not mocked) to verify
// the skill was applied correctly.

const ROOT = process.cwd();

describe('claude-mem integration', () => {
  describe('HOME_DIR export', () => {
    it('config.ts exports HOME_DIR', async () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/config.ts'), 'utf-8');
      expect(content).toContain('export const HOME_DIR');
    });
  });

  describe('findClaudeMemScripts', () => {
    it('returns null when plugin is not installed', async () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/container-runner.ts'), 'utf-8');
      expect(content).toContain('function findClaudeMemScripts()');
      expect(content).toContain("return fs.existsSync(path.join(scripts, 'mcp-server.cjs')) ? scripts : null;");
    });

    it('container-runner imports HOME_DIR', () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/container-runner.ts'), 'utf-8');
      expect(content).toContain("HOME_DIR,");
      expect(content).toContain("from './config.js'");
    });

    it('container-runner adds host-gateway flag', () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/container-runner.ts'), 'utf-8');
      expect(content).toContain('--add-host=host.docker.internal:host-gateway');
    });

    it('container-runner mounts claude-mem scripts read-only', () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/container-runner.ts'), 'utf-8');
      expect(content).toContain("containerPath: '/opt/claude-mem/scripts'");
      expect(content).toContain('readonly: true');
    });
  });

  describe('agent-runner MCP configuration', () => {
    it('allowedTools includes mcp-search wildcard', () => {
      const content = fs.readFileSync(path.join(ROOT, 'container/agent-runner/src/index.ts'), 'utf-8');
      expect(content).toContain("'mcp__mcp-search__*'");
    });

    it('registers mcp-search MCP server conditionally', () => {
      const content = fs.readFileSync(path.join(ROOT, 'container/agent-runner/src/index.ts'), 'utf-8');
      expect(content).toContain("fs.existsSync('/opt/claude-mem/scripts/mcp-server.cjs')");
      expect(content).toContain("'mcp-search'");
      expect(content).toContain("CLAUDE_MEM_WORKER_HOST: 'host.docker.internal'");
      expect(content).toContain("CLAUDE_MEM_WORKER_PORT: '37777'");
      expect(content).toContain('CLAUDE_MEM_PROJECT: containerInput.groupFolder');
    });
  });

  describe('test mock', () => {
    it('container-runner.test.ts mocks HOME_DIR', () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/container-runner.test.ts'), 'utf-8');
      expect(content).toContain("HOME_DIR: '/tmp/nanoclaw-test-home'");
    });
  });
});
