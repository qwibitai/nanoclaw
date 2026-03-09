import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('feishu skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: feishu');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@larksuiteoapi/node-sdk');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class FeishuChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('feishu'");

    // Test file for the channel
    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('FeishuChannel'");
  });

  it('has all files declared in modifies', () => {
    // Channel barrel file
    const indexFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './feishu.js'");
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('uses WebSocket long connection mode', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.ts',
    );
    const content = fs.readFileSync(channelFile, 'utf-8');

    // Should use WSClient for long connection
    expect(content).toContain('WSClient');
    expect(content).toContain('wsClient.start');
    expect(content).toContain('eventDispatcher');
  });

  it('handles various message types', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.ts',
    );
    const content = fs.readFileSync(channelFile, 'utf-8');

    // Should handle different message types
    expect(content).toContain("msg_type === 'text'");
    expect(content).toContain("msg_type === 'image'");
    expect(content).toContain("msg_type === 'file'");
    expect(content).toContain("msg_type === 'audio'");
  });

  it('uses feishu: JID prefix', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.ts',
    );
    const content = fs.readFileSync(channelFile, 'utf-8');

    expect(content).toContain("startsWith('feishu:')");
    expect(content).toContain("'feishu:'");
  });
});
