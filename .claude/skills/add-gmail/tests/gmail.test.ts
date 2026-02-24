import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');

function getGmailMode(): 'tool-only' | 'channel' {
  const p = path.join(root, '.nanoclaw/state.yaml');
  if (!fs.existsSync(p)) return 'channel';
  return read('.nanoclaw/state.yaml').includes('mode: tool-only') ? 'tool-only' : 'channel';
}

const mode = getGmailMode();
const channelOnly = mode === 'tool-only';

describe('add-gmail skill', () => {
  it('container-runner mounts ~/.gmail-mcp', () => {
    expect(read('src/container-runner.ts')).toContain('.gmail-mcp');
  });

  it('agent-runner has gmail MCP server', () => {
    const content = read('container/agent-runner/src/index.ts');
    expect(content).toContain('mcp__gmail__*');
    expect(content).toContain('@gongrzhe/server-gmail-autoauth-mcp');
  });

  it.skipIf(channelOnly)('gmail channel file exists', () => {
    expect(fs.existsSync(path.join(root, 'src/channels/gmail.ts'))).toBe(true);
  });

  it.skipIf(channelOnly)('index.ts wires up GmailChannel', () => {
    expect(read('src/index.ts')).toContain('GmailChannel');
  });

  it.skipIf(channelOnly)('googleapis dependency installed', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies?.googleapis || pkg.devDependencies?.googleapis).toBeDefined();
  });
});
