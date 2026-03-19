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
    expect(content).toContain('SIGNAL_BRIDGE_URL');
    expect(content).toContain('SIGNAL_BRIDGE_TOKEN');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'signal.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class SignalChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('signal'");

    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'signal.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.readFileSync(indexFile, 'utf-8')).toContain(
      "import './signal.js'",
    );

    const verifyFile = path.join(skillDir, 'modify', 'setup', 'verify.ts');
    expect(fs.existsSync(verifyFile)).toBe(true);
    expect(fs.readFileSync(verifyFile, 'utf-8')).toContain(
      'SIGNAL_BRIDGE_URL',
    );
    expect(fs.readFileSync(verifyFile, 'utf-8')).toContain(
      'channelAuth.signal',
    );
  });

  it('includes intent and bridge protocol docs', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'setup', 'verify.ts.intent.md'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'SIGNAL_BRIDGE_API.md'))).toBe(
      true,
    );
  });
});
