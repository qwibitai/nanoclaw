import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  listMemories,
  searchMemoriesKeyword,
} from './db.js';
import {
  deleteMemory,
  formatMemoryBlock,
  getMemoryBlock,
  saveMemory,
  updateMemory,
} from './memory-store.js';

// Mock embedding so tests don't need an OpenAI key
vi.mock('./embedding.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  _initTestDatabase();
});

describe('saveMemory', () => {
  it('saves a memory and returns an id', () => {
    const id = saveMemory(
      'group1',
      'user',
      'Dave role',
      'role desc',
      'Dave is Head of Data',
    );
    expect(id).toMatch(/^mem-/);
  });

  it('saved memory is immediately queryable via listMemories', () => {
    saveMemory('group1', 'project', 'first', 'desc', 'content');
    saveMemory('group1', 'project', 'second', 'desc', 'content');
    const all = listMemories('group1');
    expect(all[0].name).toBe('second');
    expect(all[1].name).toBe('first');
  });

  it('scopes memories to group_folder', () => {
    saveMemory('group1', 'user', 'g1 mem', 'desc', 'content');
    saveMemory('group2', 'user', 'g2 mem', 'desc', 'content');
    expect(listMemories('group1').map((m) => m.name)).toEqual(['g1 mem']);
    expect(listMemories('group2').map((m) => m.name)).toEqual(['g2 mem']);
  });

  it('sets correct type, name, description, content', () => {
    const id = saveMemory(
      'group1',
      'feedback',
      'no mocks',
      'why',
      'avoid mocking DB in tests',
    );
    const [m] = listMemories('group1');
    expect(m.id).toBe(id);
    expect(m.type).toBe('feedback');
    expect(m.name).toBe('no mocks');
    expect(m.description).toBe('why');
    expect(m.content).toBe('avoid mocking DB in tests');
  });
});

describe('deleteMemory', () => {
  it('deletes an owned memory and returns true', () => {
    const id = saveMemory('group1', 'user', 'to delete', 'desc', 'content');
    expect(deleteMemory('group1', id)).toBe(true);
    expect(listMemories('group1')).toHaveLength(0);
  });

  it('returns false when memory not found', () => {
    expect(deleteMemory('group1', 'mem-fake-id')).toBe(false);
  });

  it("cannot delete another group's memory", () => {
    const id = saveMemory('group1', 'user', 'private', 'desc', 'content');
    expect(deleteMemory('group2', id)).toBe(false);
    expect(listMemories('group1')).toHaveLength(1);
  });
});

describe('updateMemory', () => {
  it('updates content and returns true', () => {
    const id = saveMemory('group1', 'user', 'name', 'desc', 'old content');
    expect(updateMemory('group1', id, { content: 'new content' })).toBe(true);
    const [m] = listMemories('group1');
    expect(m.content).toBe('new content');
  });

  it('returns false for non-existent memory', () => {
    expect(updateMemory('group1', 'mem-fake', { content: 'x' })).toBe(false);
  });

  it("cannot update another group's memory", () => {
    const id = saveMemory('group1', 'user', 'name', 'desc', 'original');
    expect(updateMemory('group2', id, { content: 'hacked' })).toBe(false);
    const [m] = listMemories('group1');
    expect(m.content).toBe('original');
  });
});

describe('searchMemoriesKeyword', () => {
  it('finds memories matching content', () => {
    saveMemory('group1', 'user', 'Dave role', 'desc', 'Head of Data at Sunday');
    saveMemory('group1', 'project', 'deadline', 'desc', 'launch in Q2');
    const results = searchMemoriesKeyword('group1', 'Sunday');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Dave role');
  });

  it('does not return results from other groups', () => {
    saveMemory('group1', 'user', 'secret', 'desc', 'private info');
    const results = searchMemoriesKeyword('group2', 'private');
    expect(results).toHaveLength(0);
  });
});

describe('formatMemoryBlock', () => {
  it('returns empty string for no memories', () => {
    expect(formatMemoryBlock([])).toBe('');
  });

  it('wraps memories in <memories> XML block', () => {
    saveMemory('group1', 'user', 'Dave role', 'desc', 'Head of Data');
    const mems = listMemories('group1');
    const block = formatMemoryBlock(mems);
    expect(block).toContain('<memories>');
    expect(block).toContain('</memories>');
    expect(block).toContain('type="user"');
    expect(block).toContain('name="Dave role"');
    expect(block).toContain('Head of Data');
  });

  it('escapes XML special characters in content', () => {
    saveMemory(
      'group1',
      'user',
      'xss',
      'desc',
      '<script>alert("xss")</script>',
    );
    const mems = listMemories('group1');
    const block = formatMemoryBlock(mems);
    expect(block).not.toContain('<script>');
    expect(block).toContain('&lt;script&gt;');
  });

  it('escapes XML special characters in name', () => {
    saveMemory('group1', 'user', 'a & b', 'desc', 'content');
    const mems = listMemories('group1');
    const block = formatMemoryBlock(mems);
    expect(block).toContain('name="a &amp; b"');
  });
});

describe('getMemoryBlock', () => {
  it('returns empty string when group has no memories', async () => {
    const block = await getMemoryBlock('group1', 'any query');
    expect(block).toBe('');
  });

  it('returns a memory block when memories exist', async () => {
    saveMemory('group1', 'user', 'Dave role', 'desc', 'Head of Data');
    const block = await getMemoryBlock('group1', "what is Dave's role");
    expect(block).toContain('<memories>');
    expect(block).toContain('Dave role');
  });
});
