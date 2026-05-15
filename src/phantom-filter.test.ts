import { describe, expect, it } from 'vitest';

import { isPhantomText } from './phantom-filter.js';

describe('isPhantomText', () => {
  it('matches the stale feed health workspace-unmounted loop', () => {
    const text = [
      'Feed Health Check - May 4, 2026',
      '',
      'CRITICAL: Workspace unmounted - Day 22',
      '',
      'All RSS feeds inaccessible:',
      '- /workspace/group/iran-feed.rss - unreachable',
      '',
      '~220+ entries buffered in-session. No data lost. Awaiting remount.',
    ].join('\n');

    expect(isPhantomText(text)).toEqual({
      phantom: true,
      matched: 'feed-health-workspace-unmounted',
    });
  });

  it('does not drop ordinary migration or risk discussion', () => {
    expect(isPhantomText('There is data loss risk during this migration, so take a backup first.').phantom).toBe(false);
    expect(
      isPhantomText('The old laptop had a workspace unmounted error, but the current v2 claw is healthy.').phantom,
    ).toBe(false);
  });
});
