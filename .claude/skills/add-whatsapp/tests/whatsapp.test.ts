import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('whatsapp skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: whatsapp');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@whiskeysockets/baileys');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(skillDir, 'add', 'src', 'channels', 'whatsapp.ts');
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class WhatsAppChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('whatsapp'");

    // Test file for the channel
    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'whatsapp.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('WhatsAppChannel'");

    // Auth script (runtime)
    const authFile = path.join(skillDir, 'add', 'src', 'whatsapp-auth.ts');
    expect(fs.existsSync(authFile)).toBe(true);

    // Auth setup step
    const setupAuthFile = path.join(skillDir, 'add', 'setup', 'whatsapp-auth.ts');
    expect(fs.existsSync(setupAuthFile)).toBe(true);

    const setupAuthContent = fs.readFileSync(setupAuthFile, 'utf-8');
    expect(setupAuthContent).toContain('WhatsApp interactive auth');
  });

  it('has all files declared in modifies', () => {
    // Channel barrel file
    const indexFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './whatsapp.js'");

    // Setup index (adds whatsapp-auth step)
    const setupIndexFile = path.join(skillDir, 'modify', 'setup', 'index.ts');
    expect(fs.existsSync(setupIndexFile)).toBe(true);

    const setupIndexContent = fs.readFileSync(setupIndexFile, 'utf-8');
    expect(setupIndexContent).toContain("'whatsapp-auth'");
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'setup', 'index.ts.intent.md')),
    ).toBe(true);
  });
});
