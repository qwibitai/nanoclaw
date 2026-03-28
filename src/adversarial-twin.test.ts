import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ GROUPS_DIR: '/tmp/nanoclaw-twin-test' }));

import { _initTestDatabase, getDb } from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  buildAugmentedPrompt,
  buildSkepticPrompt,
  getAdversarialTranscripts,
  getTwinConfig,
  runAdversarialTwin,
  saveAdversarialTranscript,
} from './adversarial-twin.js';
import { RegisteredGroup } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('adversarial-twin', () => {
  it('getTwinConfig returns {enabled: false} when no config file exists', () => {
    const config = getTwinConfig('nonexistent-group');
    expect(config.enabled).toBe(false);
  });

  it('getTwinConfig parses adversarial-twin.json correctly', () => {
    const groupDir = '/tmp/nanoclaw-twin-test/test-group';
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/adversarial-twin.json`,
      JSON.stringify({ enabled: true, minPromptLength: 50 }),
    );

    const config = getTwinConfig('test-group');
    expect(config.enabled).toBe(true);
    expect(config.minPromptLength).toBe(50);
  });

  it('buildSkepticPrompt includes both original prompt and main response text', () => {
    const originalPrompt = 'Please explain how to sort a list in Python.';
    const mainResponse = 'You can use list.sort() or sorted(list).';

    const skepticPrompt = buildSkepticPrompt(originalPrompt, mainResponse);

    expect(skepticPrompt).toContain(originalPrompt);
    expect(skepticPrompt).toContain(mainResponse);
  });

  it('buildAugmentedPrompt wraps rebuttal in a recognizable context block', () => {
    const originalPrompt = 'Explain binary search.';
    const mainResponse = 'Binary search divides the array in half repeatedly.';
    const rebuttal = 'The response does not mention that the array must be sorted first.';

    const augmented = buildAugmentedPrompt(originalPrompt, mainResponse, rebuttal);

    expect(augmented).toContain(originalPrompt);
    expect(augmented).toContain(mainResponse);
    expect(augmented).toContain(rebuttal);
    // Should frame the rebuttal within a context block
    expect(augmented).toContain('skeptic');
  });

  it('saveAdversarialTranscript inserts and returns a positive integer ID', () => {
    const id = saveAdversarialTranscript(
      'my-group',
      'What is 2+2?',
      'It is 4.',
      null,
      null,
    );
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const row = getDb()
      .prepare('SELECT * FROM adversarial_transcripts WHERE id = ?')
      .get(id) as { group_folder: string; original_prompt: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.group_folder).toBe('my-group');
    expect(row!.original_prompt).toBe('What is 2+2?');
  });

  it('getAdversarialTranscripts returns empty array when no records', () => {
    const transcripts = getAdversarialTranscripts('empty-group');
    expect(transcripts).toEqual([]);
  });

  it('getAdversarialTranscripts respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      saveAdversarialTranscript(
        'limit-group',
        `Prompt ${i}`,
        `Response ${i}`,
        null,
        null,
      );
    }

    const all = getAdversarialTranscripts('limit-group');
    expect(all).toHaveLength(5);

    const limited = getAdversarialTranscripts('limit-group', 3);
    expect(limited).toHaveLength(3);
  });

  it('runAdversarialTwin returns null when twin is not enabled', async () => {
    // 'nonexistent-group' has no config file → enabled: false
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'nonexistent-group',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    };
    const queue = new GroupQueue();

    const result = await runAdversarialTwin(
      group,
      'A long enough prompt to meet any length requirement.',
      'The main response.',
      queue,
    );

    expect(result).toBeNull();
  });

  it('runAdversarialTwin returns null when prompt is too short (below minPromptLength)', async () => {
    // Create a config with minPromptLength=200 and enabled=true
    const groupDir = '/tmp/nanoclaw-twin-test/short-prompt-group';
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/adversarial-twin.json`,
      JSON.stringify({ enabled: true, minPromptLength: 200 }),
    );

    const group: RegisteredGroup = {
      name: 'ShortGroup',
      folder: 'short-prompt-group',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    };
    const queue = new GroupQueue();

    // Prompt is only 20 chars — below minPromptLength of 200
    const result = await runAdversarialTwin(
      group,
      'Short prompt text.',
      'Some response.',
      queue,
    );

    expect(result).toBeNull();
  });
});
