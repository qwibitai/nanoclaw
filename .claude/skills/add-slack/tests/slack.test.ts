import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('slack skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: slack');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@slack/bolt');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class SlackChannel');
    expect(content).toContain('implements Channel');

    // Test file for the channel
    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('SlackChannel'");
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'index.ts');
    const configFile = path.join(skillDir, 'modify', 'src', 'config.ts');
    const routingTestFile = path.join(skillDir, 'modify', 'src', 'routing.test.ts');

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(routingTestFile)).toBe(true);

    // Must be real merge targets, not placeholders
    expect(fs.readFileSync(indexFile, 'utf-8')).not.toContain('// TODO:');
    expect(fs.readFileSync(configFile, 'utf-8')).not.toContain('// TODO:');
    expect(fs.readFileSync(routingTestFile, 'utf-8')).not.toContain('// TODO:');
  });

  it('SlackChannel core methods are implemented', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'slack.ts');
    const content = fs.readFileSync(addFile, 'utf-8');

    expect(content).not.toContain('SlackChannel.connect() not implemented');
    expect(content).not.toContain('SlackChannel.sendMessage() not implemented');
    expect(content).not.toContain('SlackChannel.disconnect() not implemented');
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'index.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts.intent.md'))).toBe(true);
  });

  it('SKILL.md exists and references Slack', () => {
    const skillMd = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);

    const content = fs.readFileSync(skillMd, 'utf-8');
    expect(content).toContain('Add Slack Channel');
    expect(content).toContain('SLACK_BOT_TOKEN');
    expect(content).toContain('SLACK_APP_TOKEN');
    expect(content).toContain('Socket Mode');
  });
});