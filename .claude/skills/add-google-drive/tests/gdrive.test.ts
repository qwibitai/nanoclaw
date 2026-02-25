import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../../..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

describe('add-google-drive skill application', () => {
  describe('container-runner.ts', () => {
    it('imports os module', () => {
      expect(read('src/container-runner.ts')).toContain("import os from 'os'");
    });

    it('mounts ~/.gdrive-mcp into container', () => {
      expect(read('src/container-runner.ts')).toContain('.gdrive-mcp');
    });

    it('mounts gdrive credentials as read-write', () => {
      const content = read('src/container-runner.ts');
      expect(content).toContain('/home/node/.gdrive-mcp');
      // readonly: false — MCP server needs to refresh tokens
      const mountBlock = content.slice(content.indexOf('.gdrive-mcp'));
      expect(mountBlock).toContain('readonly: false');
    });
  });

  describe('agent-runner/src/index.ts', () => {
    it('allows gdrive MCP tools', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain("'mcp__gdrive__*'");
    });

    it('registers gdrive MCP server', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain('@modelcontextprotocol/server-gdrive');
    });

    it('sets GDRIVE_OAUTH_PATH env var for MCP server', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain('GDRIVE_OAUTH_PATH');
    });

    it('sets GDRIVE_CREDENTIALS_PATH env var for MCP server', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain('GDRIVE_CREDENTIALS_PATH');
    });
  });
});
