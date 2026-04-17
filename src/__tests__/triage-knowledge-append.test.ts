import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockStoreFactWithVector = vi.fn();
vi.mock('../memory/knowledge-store.js', () => ({
  storeFactWithVector: mockStoreFactWithVector,
}));

import { appendExtractedFacts } from '../triage/knowledge-append.js';

describe('appendExtractedFacts', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
    mockStoreFactWithVector.mockReset();
    mockStoreFactWithVector.mockResolvedValue(undefined);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('appends a timestamped section to the group knowledge.md', async () => {
    await appendExtractedFacts({
      groupsRoot: root,
      groupName: 'email-intel',
      threadId: 't42',
      account: 'a@b.com',
      classificationId: 'c1',
      subject: 'Shipping confirmation',
      sender: 's@amazon.com',
      facts: [
        { key: 'vendor', value: 'Amazon', source_span: 'from: s@amazon.com' },
        { key: 'tracking', value: 'TBA123', source_span: 'TBA123' },
      ],
    });

    const filePath = path.join(root, 'email-intel', 'knowledge.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const body = fs.readFileSync(filePath, 'utf8');
    expect(body).toMatch(/Shipping confirmation/);
    expect(body).toMatch(/vendor.*Amazon/);
    expect(body).toMatch(/tracking.*TBA123/);
    expect(body).toMatch(/t42/);
    expect(mockStoreFactWithVector).toHaveBeenCalledTimes(1);
    const call = mockStoreFactWithVector.mock.calls[0][0];
    expect(call.domain).toBe('email');
    expect(call.groupId).toBe('email-intel');
    expect(call.source).toBe('triage:c1');
  });

  it('is a no-op when facts is empty', async () => {
    await appendExtractedFacts({
      groupsRoot: root,
      groupName: 'email-intel',
      threadId: 't0',
      account: 'a@b.com',
      classificationId: 'c0',
      subject: 'empty',
      sender: 's@x.com',
      facts: [],
    });
    expect(
      fs.existsSync(path.join(root, 'email-intel', 'knowledge.md')),
    ).toBe(false);
    expect(mockStoreFactWithVector).not.toHaveBeenCalled();
  });

  it('swallows knowledge-store errors (non-fatal)', async () => {
    mockStoreFactWithVector.mockRejectedValueOnce(new Error('qdrant down'));
    await expect(
      appendExtractedFacts({
        groupsRoot: root,
        groupName: 'email-intel',
        threadId: 't1',
        account: 'a@b.com',
        classificationId: 'c2',
        subject: 'subj',
        sender: 's@x.com',
        facts: [{ key: 'k', value: 'v', source_span: 'span' }],
      }),
    ).resolves.toBeUndefined();
    // markdown still written
    expect(
      fs.existsSync(path.join(root, 'email-intel', 'knowledge.md')),
    ).toBe(true);
  });
});
