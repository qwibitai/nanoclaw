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
    expect(content).toContain('SIGNAL_API_BASE_URL');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.ts');
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class SignalChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('signal'");

    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'signal.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('SignalChannel'");
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './signal.js'");
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('signal.ts implements required Channel interface methods', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'signal.ts'),
      'utf-8',
    );

    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');

    expect(content).toContain('readEnvFile');
    expect(content).toContain('SIGNAL_API_BASE_URL');
    expect(content).toContain('pollMessages');
  });
});
