import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('dingtalk skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: dingtalk');
    expect(content).toContain('dingtalk-stream');
    expect(content).toContain('DINGTALK_CLIENT_ID');
  });

  it('contains declared added files', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'dingtalk.ts',
    );
    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'dingtalk.test.ts',
    );

    expect(fs.existsSync(channelFile)).toBe(true);
    expect(fs.existsSync(testFile)).toBe(true);

    expect(fs.readFileSync(channelFile, 'utf-8')).toContain(
      'class DingTalkChannel',
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toContain(
      "describe('DingTalkChannel'",
    );
  });

  it('contains declared modified files and intent notes', () => {
    const indexFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    const verifyIntent = path.join(
      skillDir,
      'modify',
      'setup',
      'verify.ts.intent.md',
    );

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.readFileSync(indexFile, 'utf-8')).toContain(
      "import './dingtalk.js'",
    );
    expect(fs.existsSync(verifyIntent)).toBe(true);
  });
});
