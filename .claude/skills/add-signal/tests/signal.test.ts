import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('signal skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: signal');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('SIGNAL_PHONE_NUMBER');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class SignalChannel');
    expect(content).toContain('implements Channel');

    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('SignalChannel'");
  });

  it('uses TCP JSON-RPC (not HTTP/SSE)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'signal.ts'),
      'utf-8',
    );
    expect(content).toContain("import net from 'net'");
    expect(content).toContain('subscribeReceive');
    expect(content).toContain('connectSocket');
    expect(content).not.toContain('/api/v1/events');
    expect(content).not.toContain('AbortController');
    expect(content).not.toContain('startSseListener');
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'index.ts');
    const configFile = path.join(skillDir, 'modify', 'src', 'config.ts');
    const routingTestFile = path.join(skillDir, 'modify', 'src', 'routing.test.ts');

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(routingTestFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain('SignalChannel');
    expect(indexContent).toContain('SIGNAL_PHONE_NUMBER');
    expect(indexContent).toContain('SIGNAL_ONLY');
    expect(indexContent).toContain('findChannel');
    expect(indexContent).toContain('channels: Channel[]');

    const configContent = fs.readFileSync(configFile, 'utf-8');
    expect(configContent).toContain('SIGNAL_PHONE_NUMBER');
    expect(configContent).toContain('SIGNAL_CLI_URL');
    expect(configContent).toContain('SIGNAL_ONLY');
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'index.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts.intent.md'))).toBe(true);
  });

  it('modified index.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

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
    expect(content).toContain('_setRegisteredGroups');
    expect(content).toContain('isDirectRun');
  });

  it('modified index.ts includes Signal channel creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    expect(content).toContain('const channels: Channel[] = []');
    expect(content).toContain('channels.push(whatsapp)');
    expect(content).toContain('channels.push(signal)');
    expect(content).toContain('if (!SIGNAL_ONLY)');
    expect(content).toContain('if (SIGNAL_PHONE_NUMBER)');
    expect(content).toContain('for (const ch of channels) await ch.disconnect()');
  });

  it('modified config.ts preserves all existing exports', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    expect(content).toContain('export const ASSISTANT_NAME');
    expect(content).toContain('export const POLL_INTERVAL');
    expect(content).toContain('export const TRIGGER_PATTERN');
    expect(content).toContain('export const CONTAINER_IMAGE');
    expect(content).toContain('export const DATA_DIR');
    expect(content).toContain('export const TIMEZONE');

    expect(content).toContain('export const SIGNAL_PHONE_NUMBER');
    expect(content).toContain('export const SIGNAL_CLI_URL');
    expect(content).toContain('export const SIGNAL_ONLY');
  });

  it('modified config.ts uses TCP default (not HTTP)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    expect(content).toContain("'localhost:7583'");
    expect(content).not.toContain('http://localhost:8080');
  });

  it('modified routing.test.ts includes Signal JID tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'routing.test.ts'),
      'utf-8',
    );

    expect(content).toContain("Signal 1:1 JID: starts with sig:");
    expect(content).toContain("Signal group JID: starts with sig:g:");
    expect(content).toContain("sig:+1234567890");
    expect(content).toContain("sig:g:");
  });

  it('has no npm dependencies (uses Node.js net module)', () => {
    const manifest = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(manifest).toContain('npm_dependencies: {}');
  });
});
