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

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain('SlackChannel');
    expect(indexContent).toContain('SLACK_ONLY');
    expect(indexContent).toContain('findChannel');
    expect(indexContent).toContain('channels: Channel[]');

    const configContent = fs.readFileSync(configFile, 'utf-8');
    expect(configContent).toContain('SLACK_ONLY');
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'index.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'routing.test.ts.intent.md'))).toBe(true);
  });

  it('has setup documentation', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'SLACK_SETUP.md'))).toBe(true);
  });

  it('modified index.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    // Core functions still present
    expect(content).toContain('function loadState()');
    expect(content).toContain('function saveState()');
    expect(content).toContain('function registerGroup(');
    expect(content).toContain('function getAvailableGroups()');
    expect(content).toContain('function processGroupMessages(');
    expect(content).toContain('function runAgent(');
    expect(content).toContain('function startMessageLoop()');
    expect(content).toContain('function recoverPendingMessages()');
    expect(content).toContain('function ensureContainerSystemRunning()');
    expect(content).toContain('async function main()');

    // Test helper preserved
    expect(content).toContain('_setRegisteredGroups');

    // Direct-run guard preserved
    expect(content).toContain('isDirectRun');
  });

  it('modified index.ts includes Slack channel creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    // Multi-channel architecture
    expect(content).toContain('const channels: Channel[] = []');
    expect(content).toContain('channels.push(whatsapp)');
    expect(content).toContain('channels.push(slack)');

    // Conditional channel creation
    expect(content).toContain('if (!SLACK_ONLY)');
    expect(content).toContain('new SlackChannel(channelOpts)');

    // Shutdown disconnects all channels
    expect(content).toContain('for (const ch of channels) await ch.disconnect()');
  });

  it('modified config.ts preserves all existing exports', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    // All original exports preserved
    expect(content).toContain('export const ASSISTANT_NAME');
    expect(content).toContain('export const POLL_INTERVAL');
    expect(content).toContain('export const TRIGGER_PATTERN');
    expect(content).toContain('export const CONTAINER_IMAGE');
    expect(content).toContain('export const DATA_DIR');
    expect(content).toContain('export const TIMEZONE');

    // Slack config added
    expect(content).toContain('export const SLACK_ONLY');
  });

  it('modified routing.test.ts includes Slack JID tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'routing.test.ts'),
      'utf-8',
    );

    // Slack JID pattern tests
    expect(content).toContain('slack:C');
    expect(content).toContain('slack:D');

    // Mixed ordering test
    expect(content).toContain('mixes WhatsApp and Slack');

    // All original WhatsApp tests preserved
    expect(content).toContain('@g.us');
    expect(content).toContain('@s.whatsapp.net');
    expect(content).toContain('__group_sync__');
  });

  it('slack.ts implements required Channel interface methods', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'slack.ts'),
      'utf-8',
    );

    // Channel interface methods
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');

    // Security pattern: reads tokens from .env, not process.env
    expect(content).toContain('readEnvFile');
    expect(content).not.toContain('process.env.SLACK_BOT_TOKEN');
    expect(content).not.toContain('process.env.SLACK_APP_TOKEN');

    // Key behaviors
    expect(content).toContain('socketMode: true');
    expect(content).toContain('MAX_MESSAGE_LENGTH');
    expect(content).toContain('thread_ts');
    expect(content).toContain('TRIGGER_PATTERN');
    expect(content).toContain('userNameCache');
  });
});
