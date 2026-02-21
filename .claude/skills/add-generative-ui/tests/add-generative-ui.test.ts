import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('add-generative-ui skill', () => {
  const skillDir = path.resolve(__dirname, '..');
  const skillPath = path.join(skillDir, 'SKILL.md');

  it('includes skill metadata and usage instructions', () => {
    expect(fs.existsSync(skillPath)).toBe(true);

    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('name: add-generative-ui');
    expect(content).toContain('mcp__nanoclaw__update_canvas');
    expect(content).toContain('/api/canvas/');
    expect(content).toContain('http://127.0.0.1:4318/canvas');
  });
});
