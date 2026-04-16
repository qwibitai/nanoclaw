import { describe, it, expect, vi } from 'vitest';

import type { Channel } from './types.js';
import {
  escapeXml,
  extractImages,
  findChannel,
  formatOutbound,
  routeOutbound,
  sendImages,
  stripInternalTags,
} from './router.js';

function makeStub(opts: {
  name?: string;
  jids?: string[];
  connected?: boolean;
  withPhoto?: boolean;
}): Channel & {
  sent: Array<[string, string]>;
  photos: Array<[string, string, string | undefined]>;
} {
  const sent: Array<[string, string]> = [];
  const photos: Array<[string, string, string | undefined]> = [];
  const owned = new Set(opts.jids ?? []);
  const ch: Channel & { sent: typeof sent; photos: typeof photos } = {
    name: opts.name ?? 'stub',
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async (jid: string, text: string) => {
      sent.push([jid, text]);
    },
    isConnected: () => opts.connected ?? true,
    ownsJid: (jid) => owned.has(jid),
    sent,
    photos,
  };
  if (opts.withPhoto) {
    ch.sendPhoto = async (jid: string, p: string, caption?: string) => {
      photos.push([jid, p, caption]);
    };
  }
  return ch;
}

describe('escapeXml', () => {
  it('escapes special characters', () => {
    expect(escapeXml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeXml('')).toBe('');
  });
});

describe('stripInternalTags', () => {
  it('strips a complete <internal>...</internal> block', () => {
    expect(stripInternalTags('hello <internal>thoughts</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips an unterminated <internal>... tail', () => {
    expect(stripInternalTags('hello <internal>still thinking')).toBe('hello');
  });

  it('strips a partial "<int" prefix at end of text', () => {
    expect(stripInternalTags('hello <inter')).toBe('hello');
  });

  it('leaves text without internal tags untouched', () => {
    expect(stripInternalTags('just text')).toBe('just text');
  });
});

describe('formatOutbound', () => {
  it('removes internal tags and trims whitespace', () => {
    expect(formatOutbound('  hi <internal>ignored</internal>  ')).toBe('hi');
  });

  it('returns empty string when only internal content exists', () => {
    expect(formatOutbound('<internal>everything</internal>')).toBe('');
  });
});

describe('extractImages', () => {
  it('extracts image tags and returns clean text', () => {
    const input =
      'hello <image path="/a.png" /> world <image path="/b.jpg" caption="cap" />';
    const { cleanText, images } = extractImages(input);
    expect(cleanText).toBe('hello  world');
    expect(images).toEqual([
      { path: '/a.png', caption: undefined },
      { path: '/b.jpg', caption: 'cap' },
    ]);
  });

  it('returns empty image list when no tags present', () => {
    const { cleanText, images } = extractImages('no images here');
    expect(cleanText).toBe('no images here');
    expect(images).toEqual([]);
  });
});

describe('sendImages', () => {
  it('sends each image via the channel', async () => {
    const ch = makeStub({ jids: ['g@g.us'], withPhoto: true });
    await sendImages(ch, 'g@g.us', [
      { path: '/x.png', caption: 'one' },
      { path: '/y.png' },
    ]);
    expect(ch.photos).toEqual([
      ['g@g.us', '/x.png', 'one'],
      ['g@g.us', '/y.png', undefined],
    ]);
  });

  it('is a no-op when the channel does not support sendPhoto', async () => {
    const ch = makeStub({ jids: ['g@g.us'], withPhoto: false });
    await expect(
      sendImages(ch, 'g@g.us', [{ path: '/x.png' }]),
    ).resolves.toBeUndefined();
  });
});

describe('routeOutbound', () => {
  it('sends via the channel that owns the jid', async () => {
    const chA = makeStub({ name: 'a', jids: ['a@g.us'] });
    const chB = makeStub({ name: 'b', jids: ['b@g.us'] });
    await routeOutbound([chA, chB], 'b@g.us', 'hi');
    expect(chA.sent).toEqual([]);
    expect(chB.sent).toEqual([['b@g.us', 'hi']]);
  });

  it('skips channels that are not connected', async () => {
    const chOffline = makeStub({ jids: ['x@g.us'], connected: false });
    const chOnline = makeStub({ jids: ['x@g.us'], connected: true });
    await routeOutbound([chOffline, chOnline], 'x@g.us', 'hi');
    expect(chOffline.sent).toEqual([]);
    expect(chOnline.sent).toEqual([['x@g.us', 'hi']]);
  });

  it('throws when no channel owns the jid', () => {
    const ch = makeStub({ jids: ['a@g.us'] });
    expect(() => routeOutbound([ch], 'missing@g.us', 'hi')).toThrow(
      /No channel/,
    );
  });
});

describe('findChannel', () => {
  it('returns the owning channel regardless of connection state', () => {
    const ch = makeStub({
      name: 'offline',
      jids: ['x@g.us'],
      connected: false,
    });
    expect(findChannel([ch], 'x@g.us')).toBe(ch);
  });

  it('returns undefined when no channel owns the jid', () => {
    const ch = makeStub({ jids: ['a@g.us'] });
    expect(findChannel([ch], 'b@g.us')).toBeUndefined();
  });
});
