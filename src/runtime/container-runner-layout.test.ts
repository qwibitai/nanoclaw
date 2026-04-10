import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureGroupSessionSettings } from './container-runner-layout.js';

describe('ensureGroupSessionSettings', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates existing settings file to enforce deterministic env keys', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-layout-'));
    roots.push(root);

    const groupSessionsDir = path.join(root, '.claude');
    fs.mkdirSync(groupSessionsDir, { recursive: true });
    const settingsPath = path.join(groupSessionsDir, 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CUSTOM_FLAG: 'keep-me',
          },
          custom: true,
        },
        null,
        2,
      ),
    );

    ensureGroupSessionSettings(groupSessionsDir);

    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
      custom: boolean;
    };

    expect(updated.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('0');
    expect(updated.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(updated.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    expect(updated.env.CUSTOM_FLAG).toBe('keep-me');
    expect(updated.custom).toBe(true);
  });
});
