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
    expect(content).toContain('version: 1.0.1');
    expect(content).toContain('@larksuiteoapi/node-sdk');
    expect(content).toContain('src/container-runner.ts');
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

    const containerRunnerFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts',
    );
    expect(fs.existsSync(containerRunnerFile)).toBe(true);

    const containerRunnerContent = fs.readFileSync(containerRunnerFile, 'utf-8');
    expect(containerRunnerContent).toContain('agent-runner-src');
    expect(containerRunnerContent).toContain('force: true');
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'container-runner.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('uses media_type for send_media and regular-file video fallback', () => {
    const mcpFile = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'ipc-mcp-stdio.ts',
    );
    const mcpContent = fs.readFileSync(mcpFile, 'utf-8');
    expect(mcpContent).toContain('media_type');

    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'feishu.ts',
    );
    const channelContent = fs.readFileSync(channelFile, 'utf-8');
    expect(channelContent).toContain("media.type === 'video'");
    expect(channelContent).toContain("? 'stream'");
  });

  it('has SKILL.md with setup instructions', () => {
    const skillMd = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);

    const content = fs.readFileSync(skillMd, 'utf-8');
    expect(content).toContain('FEISHU_APP_ID');
    expect(content).toContain('FEISHU_APP_SECRET');
    expect(content).toContain('open.feishu.cn');
    expect(content).toContain('im.message.receive_v1');
  });
});
