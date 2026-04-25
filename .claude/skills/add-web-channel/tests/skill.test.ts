import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('add-web-channel skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: web-channel');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('redis');
    expect(content).toContain('WEB_CHANNEL_ENABLED');
  });

  it('contains add files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'add', 'src', 'channels', 'web.ts')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'add', 'src', 'channels', 'web.test.ts'),
      ),
    ).toBe(true);
  });

  it('contains modified file snapshots and intent files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts')),
    ).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', '.env.example'))).toBe(
      true,
    );

    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'modify',
          'src',
          'channels',
          'index.ts.intent.md',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'config.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('contains web template routes', () => {
    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'assets',
          'web-template',
          'app',
          'api',
          'auth',
          'route.ts',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'assets',
          'web-template',
          'app',
          'api',
          'send',
          'route.ts',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'assets',
          'web-template',
          'app',
          'api',
          'stream',
          'route.ts',
        ),
      ),
    ).toBe(true);
  });
});
