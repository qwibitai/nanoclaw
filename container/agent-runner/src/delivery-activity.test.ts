import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  appendSendMessageActivity,
  consumeSendMessageCount,
  hasVisibleReply,
  stripInternalTags,
} from './delivery-activity.js';

function makeActivityFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-activity-'));
  return path.join(dir, 'activity.log');
}

function cleanupActivityFile(filePath: string): void {
  fs.rmSync(path.dirname(filePath), { force: true, recursive: true });
}

describe('stripInternalTags', () => {
  it('keeps visible text while removing internal sections', () => {
    expect(
      stripInternalTags(
        'visible <internal>secret</internal> text <internal>hidden</internal>',
      ),
    ).toBe('visible  text');
  });
});

describe('hasVisibleReply', () => {
  it('returns false for internal-only and whitespace-only values', () => {
    expect(hasVisibleReply('<internal>secret</internal>')).toBe(false);
    expect(hasVisibleReply('   \n\t  ')).toBe(false);
    expect(hasVisibleReply(undefined)).toBe(false);
    expect(hasVisibleReply(null)).toBe(false);
  });
});

describe('send_message activity', () => {
  it('treats blank send_message writes as zero delivery activity', () => {
    const activityFile = makeActivityFile();

    try {
      appendSendMessageActivity(activityFile, '   \n\t  ');

      expect(consumeSendMessageCount(activityFile)).toBe(0);
    } finally {
      cleanupActivityFile(activityFile);
    }
  });

  it('counts non-empty send_message delivery exactly once', () => {
    const activityFile = makeActivityFile();

    try {
      appendSendMessageActivity(activityFile, 'Message sent');

      expect(consumeSendMessageCount(activityFile)).toBe(1);
      expect(consumeSendMessageCount(activityFile)).toBe(0);
    } finally {
      cleanupActivityFile(activityFile);
    }
  });
});
