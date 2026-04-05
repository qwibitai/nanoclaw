import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const root = process.cwd();

function read(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

describe('add-composio skill application', () => {
  describe('container-runner.ts', () => {
    it('reads Composio API key from ~/.composio/api.key', () => {
      expect(read('src/container-runner.ts')).toContain('.composio');
    });

    it('passes COMPOSIO_API_KEY as Docker env var', () => {
      expect(read('src/container-runner.ts')).toContain('COMPOSIO_API_KEY');
    });
  });

  describe('agent-runner/src/index.ts', () => {
    it('allows composio MCP tools', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain("'mcp__composio__*'");
    });

    it('registers composio MCP server', () => {
      expect(read('container/agent-runner/src/index.ts')).toContain('@composio/mcp');
    });

    it('passes COMPOSIO_API_KEY to MCP server env', () => {
      const content = read('container/agent-runner/src/index.ts');
      const composioBlock = content.slice(content.indexOf('composio:'));
      expect(composioBlock).toContain('COMPOSIO_API_KEY');
    });
  });
});
