import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  activateShadowGroup,
  getShadowActivationThreshold,
  getShadowMessageCount,
  getShadowResponses,
  incrementShadowMessageCount,
  isGroupInShadowMode,
  setShadowMode,
  storeShadowResponse,
} from './shadow-mode.js';

function insertGroup(
  jid: string,
  folder: string,
  shadowMode = 0,
  threshold = 10,
) {
  getDb()
    .prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, shadow_mode, shadow_activation_threshold, shadow_message_count)
       VALUES (?, ?, ?, '', ?, ?, ?, 0)`,
    )
    .run(jid, 'Test', folder, new Date().toISOString(), shadowMode, threshold);
}

describe('shadow-mode', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('isGroupInShadowMode returns false for freshly registered group (shadow_mode=0)', () => {
    insertGroup('fresh@g.us', 'fresh-group');
    expect(isGroupInShadowMode('fresh@g.us')).toBe(false);
  });

  it('setShadowMode(jid, true) makes isGroupInShadowMode return true', () => {
    insertGroup('toggle@g.us', 'toggle-group');
    setShadowMode('toggle@g.us', true);
    expect(isGroupInShadowMode('toggle@g.us')).toBe(true);
  });

  it('storeShadowResponse inserts a row retrievable by getShadowResponses', () => {
    insertGroup('store@g.us', 'store-group');
    storeShadowResponse('store-group', 'store@g.us', 'Hello?', 'Hi there!');
    const responses = getShadowResponses('store-group');
    expect(responses).toHaveLength(1);
    expect(responses[0].prompt).toBe('Hello?');
    expect(responses[0].response).toBe('Hi there!');
    expect(responses[0].chat_jid).toBe('store@g.us');
    expect(responses[0].group_folder).toBe('store-group');
  });

  it('incrementShadowMessageCount increments count by 1', () => {
    insertGroup('incr@g.us', 'incr-group', 0, 100);
    expect(getShadowMessageCount('incr@g.us')).toBe(0);
    incrementShadowMessageCount('incr@g.us');
    expect(getShadowMessageCount('incr@g.us')).toBe(1);
    incrementShadowMessageCount('incr@g.us');
    expect(getShadowMessageCount('incr@g.us')).toBe(2);
  });

  it('incrementShadowMessageCount auto-activates when count reaches threshold', () => {
    insertGroup('auto@g.us', 'auto-group', 1, 2);
    expect(isGroupInShadowMode('auto@g.us')).toBe(true);

    incrementShadowMessageCount('auto@g.us'); // count = 1, threshold = 2
    expect(isGroupInShadowMode('auto@g.us')).toBe(true);

    incrementShadowMessageCount('auto@g.us'); // count = 2, threshold = 2 => activates
    // activateShadowGroup sets shadow_mode = 0 and resets count
    expect(isGroupInShadowMode('auto@g.us')).toBe(false);
    expect(getShadowMessageCount('auto@g.us')).toBe(0);
  });

  it('activateShadowGroup sets shadow_mode=0', () => {
    insertGroup('act@g.us', 'act-group', 1);
    expect(isGroupInShadowMode('act@g.us')).toBe(true);
    activateShadowGroup('act@g.us');
    expect(isGroupInShadowMode('act@g.us')).toBe(false);
  });

  it('getShadowResponses respects limit parameter', () => {
    insertGroup('limit@g.us', 'limit-group');
    for (let i = 0; i < 5; i++) {
      storeShadowResponse(
        'limit-group',
        'limit@g.us',
        `Prompt ${i}`,
        `Response ${i}`,
      );
    }
    const limited = getShadowResponses('limit-group', 3);
    expect(limited).toHaveLength(3);
  });

  it('getShadowActivationThreshold returns correct value', () => {
    insertGroup('thresh@g.us', 'thresh-group', 0, 25);
    expect(getShadowActivationThreshold('thresh@g.us')).toBe(25);
  });

  it('isGroupInShadowMode returns false when jid not found', () => {
    expect(isGroupInShadowMode('nonexistent@g.us')).toBe(false);
  });
});
