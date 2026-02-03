import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh } from './test-helpers.js';

test('validateMount enforces allowlist and blocked patterns', async () => {
  const previousHome = process.env.HOME;
  const previousLogLevel = process.env.LOG_LEVEL;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-home-'));
  const configDir = path.join(tempHome, '.config', 'dotclaw');
  fs.mkdirSync(configDir, { recursive: true });

  const safeRoot = fs.mkdtempSync(path.join(tempHome, 'safe-root-'));
  const blockedDir = path.join(safeRoot, 'secret-notes');
  fs.mkdirSync(blockedDir, { recursive: true });

  const allowlist = {
    allowedRoots: [
      {
        path: safeRoot,
        allowReadWrite: true,
        description: 'Test root'
      }
    ],
    blockedPatterns: ['secret'],
    nonMainReadOnly: false
  };

  fs.writeFileSync(path.join(configDir, 'mount-allowlist.json'), JSON.stringify(allowlist, null, 2));

  process.env.HOME = tempHome;
  process.env.LOG_LEVEL = 'silent';

  try {
    const { validateMount } = await importFresh(distPath('mount-security.js'));

    const allowed = validateMount({
      hostPath: safeRoot,
      containerPath: 'data',
      readonly: false
    }, true);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.effectiveReadonly, false);

    const blocked = validateMount({
      hostPath: blockedDir,
      containerPath: 'data',
      readonly: false
    }, true);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /blocked pattern/i);

    const invalid = validateMount({
      hostPath: safeRoot,
      containerPath: '../escape',
      readonly: false
    }, true);
    assert.equal(invalid.allowed, false);
    assert.match(invalid.reason, /invalid container path/i);
  } finally {
    process.env.HOME = previousHome;
    process.env.LOG_LEVEL = previousLogLevel;
  }
});
