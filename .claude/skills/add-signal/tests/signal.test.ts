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
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class SignalChannel');
    expect(content).toContain('implements Channel');

    // Test file for the channel
    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('SignalChannel'");
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'index.ts');
    const configFile = path.join(skillDir, 'modify', 'src', 'config.ts');

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain('SignalChannel');
    expect(indexContent).toContain('SIGNAL_ONLY');
    expect(indexContent).toContain('SIGNAL_PHONE_NUMBER');
    expect(indexContent).toContain('findChannel');
    expect(indexContent).toContain('channels: Channel[]');

    const configContent = fs.readFileSync(configFile, 'utf-8');
    expect(configContent).toContain('SIGNAL_PHONE_NUMBER');
    expect(configContent).toContain('SIGNAL_CLI_PATH');
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

  it('modified index.ts includes Signal channel creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    // Multi-channel architecture
    expect(content).toContain('const channels: Channel[] = []');
    expect(content).toContain('channels.push(whatsapp)');
    expect(content).toContain('channels.push(signal)');

    // Conditional channel creation
    expect(content).toContain('if (!SIGNAL_ONLY)');
    expect(content).toContain('if (SIGNAL_PHONE_NUMBER)');

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
  });

  it('modified index.ts preserves upstream security and API patterns', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    // registerGroup must use resolveGroupFolderPath (not naive path.join)
    expect(content).toContain('resolveGroupFolderPath');
    expect(content).toContain("import { resolveGroupFolderPath } from './group-folder.js'");

    // runContainerAgent must pass assistantName
    expect(content).toContain('assistantName: ASSISTANT_NAME');

    // Should NOT import DATA_DIR (upstream removed it from index.ts)
    expect(content).not.toMatch(/import\s*\{[^}]*DATA_DIR[^}]*\}\s*from\s*'\.\/config\.js'/);
  });

  it('add/ signal.ts includes security hardening', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'signal.ts'),
      'utf-8',
    );

    expect(content).toContain('MAX_PENDING_RPC');
    expect(content).toContain('MAX_OUTGOING_QUEUE');
    expect(content).toContain('MAX_STDOUT_BUFFER');
    // Disconnect cleanup
    expect(content).toContain('pendingRpc.clear()');
  });
});
