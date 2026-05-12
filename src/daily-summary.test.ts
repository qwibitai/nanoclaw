import { describe, expect, it } from 'vitest';

import { extractRepo, formatDigest } from './daily-summary.js';
import type { ShipLogEntry, BacklogItem } from './db/backlog.js';
import type { AgentGroup } from './types.js';

function shipEntry(over: Partial<ShipLogEntry> = {}): ShipLogEntry {
  return {
    id: 'ship-1',
    agent_group_id: 'ag-x',
    title: 'untitled',
    description: null,
    pr_url: null,
    branch: null,
    tags: null,
    shipped_at: '2026-05-12T12:00:00.000Z',
    ...over,
  };
}

function backlogItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'bl-1',
    agent_group_id: 'ag-x',
    title: 'untitled',
    description: null,
    status: 'open',
    priority: 'medium',
    tags: null,
    notes: null,
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
    resolved_at: null,
    ...over,
  };
}

const fakeGroup: AgentGroup = {
  id: 'ag-x',
  name: 'illysium',
  folder: 'illysium',
  agent_provider: 'claude',
  created_at: '2026-04-01T00:00:00.000Z',
};

describe('extractRepo', () => {
  it('parses owner/repo from a github PR url', () => {
    expect(extractRepo(shipEntry({ pr_url: 'https://github.com/Illysium-ai/ILLYSE/pull/1234' }))).toBe(
      'Illysium-ai/ILLYSE',
    );
  });

  it('parses owner/repo from a github issues url', () => {
    expect(extractRepo(shipEntry({ pr_url: 'https://github.com/davekim917/nanoclaw/issues/42' }))).toBe(
      'davekim917/nanoclaw',
    );
  });

  it('uses comma-separated tag fallback (commit-scan format)', () => {
    expect(extractRepo(shipEntry({ tags: 'commit-digest,nanoclaw-v2' }))).toBe('nanoclaw-v2');
  });

  it('uses JSON-array tag fallback (legacy v1 format)', () => {
    expect(extractRepo(shipEntry({ tags: '["commit-digest","ILLYSE"]' }))).toBe('ILLYSE');
  });

  it('uses title prefix when colon appears in first 40 chars', () => {
    expect(extractRepo(shipEntry({ title: 'nanoclaw-v2: bump foo' }))).toBe('nanoclaw-v2');
  });

  it("returns 'Other' when title colon is past char 40", () => {
    expect(extractRepo(shipEntry({ title: 'this is a very long title with no colon for fifty chars: ok' }))).toBe(
      'Other',
    );
  });

  it("returns 'Other' when nothing matches", () => {
    expect(extractRepo(shipEntry({ title: 'just a plain title' }))).toBe('Other');
  });

  it('prefers pr_url over title prefix', () => {
    expect(
      extractRepo(
        shipEntry({
          pr_url: 'https://github.com/owner/repo/pull/1',
          title: 'something-else: blah',
        }),
      ),
    ).toBe('owner/repo');
  });
});

describe('formatDigest', () => {
  it('emits only the header when all sources are empty', () => {
    const out = formatDigest(fakeGroup, { shipped: [], resolved: [], openBacklog: [] });
    // Header line only — caller is expected to skip-empty before formatting.
    expect(out).toBe('📋 **Daily Summary** — illysium');
  });

  it('renders Agent Shipped without per-repo header when only one repo', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [
        shipEntry({ title: 'fix: x', pr_url: 'https://github.com/o/r/pull/1' }),
        shipEntry({ id: 'ship-2', title: 'feat: y', pr_url: 'https://github.com/o/r/pull/2' }),
      ],
      resolved: [],
      openBacklog: [],
    });
    expect(out).toContain('🤖 **Agent Shipped** (2):');
    expect(out).not.toContain('**o/r**');
    expect(out).toContain('• fix: x — https://github.com/o/r/pull/1');
    expect(out).toContain('• feat: y — https://github.com/o/r/pull/2');
  });

  it('emits per-repo header when multiple repos', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [
        shipEntry({ title: 'a', pr_url: 'https://github.com/o/r1/pull/1' }),
        shipEntry({ id: 'ship-2', title: 'b', pr_url: 'https://github.com/o/r2/pull/2' }),
      ],
      resolved: [],
      openBacklog: [],
    });
    expect(out).toContain('**o/r1**');
    expect(out).toContain('**o/r2**');
  });

  it('omits PR-url suffix when entry has no pr_url', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [shipEntry({ title: 'plain-shipped', pr_url: null })],
      resolved: [],
      openBacklog: [],
    });
    expect(out).toContain('• plain-shipped');
    expect(out).not.toContain('• plain-shipped —');
  });

  it('renders Resolved with the right emoji per status', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [],
      resolved: [
        backlogItem({ id: 'b1', title: 'fixed-issue', status: 'resolved' }),
        backlogItem({ id: 'b2', title: 'wont-do', status: 'wont_fix' }),
      ],
      openBacklog: [],
    });
    expect(out).toContain('✅ **Resolved** (2):');
    expect(out).toContain('✅ fixed-issue');
    expect(out).toContain('🚫 wont-do');
  });

  it('renders Open Backlog with priority emoji + in-progress suffix', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [],
      resolved: [],
      openBacklog: [
        backlogItem({ id: 'b1', title: 'high-thing', priority: 'high', status: 'open' }),
        backlogItem({ id: 'b2', title: 'mid-thing', priority: 'medium', status: 'in_progress' }),
        backlogItem({ id: 'b3', title: 'low-thing', priority: 'low', status: 'open' }),
      ],
    });
    expect(out).toContain('📌 **Open Backlog** (3):');
    expect(out).toContain('🔴 high-thing');
    expect(out).toContain('🟡 mid-thing [in progress]');
    expect(out).toContain('⚪ low-thing');
    expect(out).not.toContain('🔴 high-thing [in progress]');
  });

  it('omits sections that have no entries', () => {
    const out = formatDigest(fakeGroup, {
      shipped: [shipEntry({ title: 'only-ship' })],
      resolved: [],
      openBacklog: [],
    });
    expect(out).toContain('🤖 **Agent Shipped**');
    expect(out).not.toContain('✅ **Resolved**');
    expect(out).not.toContain('📌 **Open Backlog**');
  });

  it('uses group.name as the header label, falling back to folder then id', () => {
    expect(formatDigest({ ...fakeGroup, name: '' }, { shipped: [], resolved: [], openBacklog: [] })).toContain(
      '— illysium',
    );
    expect(
      formatDigest({ ...fakeGroup, name: '', folder: '' }, { shipped: [], resolved: [], openBacklog: [] }),
    ).toContain('— ag-x');
  });
});
