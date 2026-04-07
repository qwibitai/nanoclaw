import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { AgentImpl } from './agent-impl.js';
import { buildAgentConfig } from './agent-config.js';
import { buildRuntimeConfig } from './runtime-config.js';

const agentConfig = buildAgentConfig('test', undefined, '/tmp/agentlite-test');
const runtimeConfig = buildRuntimeConfig({}, '/tmp/agentlite-test-pkg');
const testInstance = new AgentImpl(agentConfig, runtimeConfig);

beforeEach(() => {
  _initTestDatabase();
  testInstance._setRegisteredGroups({});
  (testInstance as unknown as { _started: boolean })._started = true;
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = testInstance.getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = testInstance.getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    testInstance._setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = testInstance.getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = testInstance.getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = testInstance.getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = testInstance.getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- getRegisteredGroups ---

describe('getRegisteredGroups', () => {
  it('returns an empty array when no groups are registered', () => {
    expect(testInstance.getRegisteredGroups()).toEqual([]);
  });

  it('returns registered groups with jid and optional fields preserved', () => {
    testInstance._setRegisteredGroups({
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
        isMain: true,
        containerConfig: {
          timeout: 1234,
          additionalMounts: [
            {
              hostPath: '/tmp/data',
              containerPath: '/workspace/data',
              readonly: false,
            },
          ],
        },
      },
    });

    expect(testInstance.getRegisteredGroups()).toEqual([
      {
        jid: 'main@g.us',
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
        isMain: true,
        containerConfig: {
          timeout: 1234,
          additionalMounts: [
            {
              hostPath: '/tmp/data',
              containerPath: '/workspace/data',
              readonly: false,
            },
          ],
        },
      },
    ]);
  });

  it('returns defensive snapshots instead of live mutable references', () => {
    testInstance._setRegisteredGroups({
      'group@g.us': {
        name: 'Original',
        folder: 'group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/tmp/source',
              containerPath: '/workspace/source',
              readonly: true,
            },
          ],
        },
      },
    });

    const snapshot = testInstance.getRegisteredGroups();
    snapshot[0].name = 'Mutated';
    snapshot[0].containerConfig!.additionalMounts![0].hostPath = '/tmp/mutated';

    expect(testInstance.getRegisteredGroups()).toEqual([
      {
        jid: 'group@g.us',
        name: 'Original',
        folder: 'group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '/tmp/source',
              containerPath: '/workspace/source',
              readonly: true,
            },
          ],
        },
      },
    ]);
  });
});

describe('group getters require start()', () => {
  it('throws before start', () => {
    const unstarted = new AgentImpl(agentConfig, runtimeConfig);

    expect(() => unstarted.getRegisteredGroups()).toThrow(
      'Call start() before getRegisteredGroups()',
    );
    expect(() => unstarted.getAvailableGroups()).toThrow(
      'Call start() before getAvailableGroups()',
    );
  });
});
