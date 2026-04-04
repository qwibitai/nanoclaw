import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/test-groups',
}));

import { cleanupOldAudioAttachments } from './attachment-cleanup.js';

describe('cleanupOldAudioAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes audio files older than 30 days', () => {
    const now = Date.now();
    const oldTimestamp = now - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    const recentTimestamp = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago

    vi.spyOn(fs, 'readdirSync')
      .mockReturnValueOnce(
        [{ name: 'test-group', isDirectory: () => true }] as any,
      )
      .mockReturnValueOnce([
        { name: `${oldTimestamp}-clip.m4a`, isDirectory: () => false },
        { name: `${recentTimestamp}-clip2.m4a`, isDirectory: () => false },
        { name: `${oldTimestamp}-doc.pdf`, isDirectory: () => false },
      ] as any);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    cleanupOldAudioAttachments();

    // Only the old audio file should be deleted
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith(
      path.join(
        '/tmp/test-groups',
        'test-group',
        'attachments',
        `${oldTimestamp}-clip.m4a`,
      ),
    );
  });

  it('does not delete recent audio files', () => {
    const now = Date.now();
    const recentTimestamp = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

    vi.spyOn(fs, 'readdirSync')
      .mockReturnValueOnce(
        [{ name: 'group1', isDirectory: () => true }] as any,
      )
      .mockReturnValueOnce([
        { name: `${recentTimestamp}-voice.m4a`, isDirectory: () => false },
      ] as any);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

    cleanupOldAudioAttachments();

    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('handles missing attachments directory gracefully', () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValueOnce(
      [{ name: 'group1', isDirectory: () => true }] as any,
    );
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() => cleanupOldAudioAttachments()).not.toThrow();
  });
});
