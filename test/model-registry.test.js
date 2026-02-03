import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('resolveModel respects group/user overrides with allowlist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-model-'));
  await withTempCwd(tempDir, async () => {
    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'model.json'), JSON.stringify({
      model: 'openai/gpt-4.1-mini',
      allowlist: ['openai/gpt-4.1-mini', 'anthropic/claude-3.5-sonnet'],
      per_group: {
        main: { model: 'unknown/not-allowed' }
      },
      per_user: {
        alice: { model: 'anthropic/claude-3.5-sonnet' }
      },
      overrides: {
        'anthropic/claude-3.5-sonnet': { temperature: 0.2 }
      }
    }, null, 2));

    const { resolveModel } = await importFresh(distPath('model-registry.js'));

    const groupResult = resolveModel({
      groupFolder: 'main',
      defaultModel: 'openai/gpt-4.1-mini'
    });
    assert.equal(groupResult.model, 'openai/gpt-4.1-mini');

    const userResult = resolveModel({
      groupFolder: 'main',
      userId: 'alice',
      defaultModel: 'openai/gpt-4.1-mini'
    });
    assert.equal(userResult.model, 'anthropic/claude-3.5-sonnet');
    assert.equal(userResult.override?.temperature, 0.2);
  });
});
