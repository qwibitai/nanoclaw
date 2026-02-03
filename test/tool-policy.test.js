import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('getEffectiveToolPolicy merges allow/deny/max rules', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-policy-'));
  await withTempCwd(tempDir, async () => {
    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tool-policy.json'), JSON.stringify({
      default: {
        allow: ['Read', 'Write'],
        deny: ['Bash'],
        max_per_run: { WebSearch: 2 },
        default_max_per_run: 5
      },
      groups: {
        main: {
          allow: ['Read'],
          deny: ['WebFetch'],
          max_per_run: { WebSearch: 1 }
        }
      },
      users: {
        alice: {
          deny: ['Write'],
          default_max_per_run: 3
        }
      }
    }, null, 2));

    const { getEffectiveToolPolicy } = await importFresh(distPath('tool-policy.js'));
    const policy = getEffectiveToolPolicy({ groupFolder: 'main', userId: 'alice' });

    assert.deepEqual(policy.allow, ['Read']);
    assert.deepEqual(policy.deny?.sort(), ['Bash', 'WebFetch', 'Write'].sort());
    assert.equal(policy.max_per_run?.WebSearch, 1);
    assert.equal(policy.default_max_per_run, 3);
  });
});
