import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('convert-to-apple-container skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: convert-to-apple-container');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('container-runtime.ts');
    expect(content).toContain('container/build.sh');
  });

  it('has all modified files', () => {
    const runtimeFile = path.join(skillDir, 'modify', 'src', 'container-runtime.ts');
    expect(fs.existsSync(runtimeFile)).toBe(true);

    const content = fs.readFileSync(runtimeFile, 'utf-8');
    expect(content).toContain("CONTAINER_RUNTIME_BIN = 'container'");
    expect(content).toContain('system status');
    expect(content).toContain('system start');
    expect(content).toContain('ls --format json');

    const testFile = path.join(skillDir, 'modify', 'src', 'container-runtime.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain('system status');
    expect(testContent).toContain('--mount');
  });

  it('has intent files for modified sources', () => {
    const runtimeIntent = path.join(skillDir, 'modify', 'src', 'container-runtime.ts.intent.md');
    expect(fs.existsSync(runtimeIntent)).toBe(true);

    const buildIntent = path.join(skillDir, 'modify', 'container', 'build.sh.intent.md');
    expect(fs.existsSync(buildIntent)).toBe(true);
  });

  it('has build.sh with Apple Container default', () => {
    const buildFile = path.join(skillDir, 'modify', 'container', 'build.sh');
    expect(fs.existsSync(buildFile)).toBe(true);

    const content = fs.readFileSync(buildFile, 'utf-8');
    expect(content).toContain('CONTAINER_RUNTIME:-container');
    expect(content).not.toContain('CONTAINER_RUNTIME:-docker');
  });

  it('uses Apple Container API patterns (not Docker)', () => {
    const runtimeFile = path.join(skillDir, 'modify', 'src', 'container-runtime.ts');
    const content = fs.readFileSync(runtimeFile, 'utf-8');

    // Apple Container patterns
    expect(content).toContain('system status');
    expect(content).toContain('system start');
    expect(content).toContain('ls --format json');
    expect(content).toContain('type=bind,source=');

    // Should NOT contain Docker patterns
    expect(content).not.toContain('docker info');
    expect(content).not.toContain("'-v'");
    expect(content).not.toContain('--filter name=');
  });
});
