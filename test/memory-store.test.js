import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('memory store supports upsert, search, list, and forget flows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-mem-'));
  await withTempCwd(tempDir, async () => {
    const { initMemoryStore, upsertMemoryItems, searchMemories, listMemories, forgetMemories, getMemoryStats, buildUserProfile, buildMemoryRecall } =
      await importFresh(distPath('memory-store.js'));

    initMemoryStore();

    const inserted = upsertMemoryItems('main', [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: 'Likes espresso',
        tags: ['coffee'],
        importance: 0.8
      },
      {
        scope: 'group',
        type: 'project',
        content: 'Project Apollo kickoff meeting Friday',
        tags: ['apollo'],
        importance: 0.7
      }
    ], 'test');

    assert.equal(inserted.length, 2);

    const searchResults = searchMemories({
      groupFolder: 'main',
      userId: 'user-1',
      query: 'espresso'
    });
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].content, 'Likes espresso');

    const listResults = listMemories({ groupFolder: 'main', scope: 'user', userId: 'user-1' });
    assert.equal(listResults.length, 1);

    const profile = buildUserProfile({ groupFolder: 'main', userId: 'user-1' });
    assert.ok(profile?.includes('Likes espresso'));

    const recall = buildMemoryRecall({ groupFolder: 'main', userId: 'user-1', query: 'apollo' });
    assert.equal(recall.length, 1);
    assert.ok(recall[0].includes('Project Apollo'));

    const stats = getMemoryStats({ groupFolder: 'main', userId: 'user-1' });
    assert.equal(stats.total, 2);
    assert.equal(stats.user, 1);
    assert.equal(stats.group, 1);

    const removed = forgetMemories({
      groupFolder: 'main',
      content: 'Likes espresso',
      scope: 'user',
      userId: 'user-1'
    });
    assert.equal(removed, 1);
  });
});
