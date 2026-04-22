import { describe, it, expect } from 'vitest';

import { parseOutboundSegments } from './outbound-parse.js';

describe('parseOutboundSegments', () => {
  it('returns a single text segment when no markers are present', () => {
    expect(parseOutboundSegments('hello world')).toEqual([
      { kind: 'text', text: 'hello world' },
    ]);
  });

  it('returns nothing for empty / whitespace-only input', () => {
    expect(parseOutboundSegments('')).toEqual([]);
    expect(parseOutboundSegments('   \n  ')).toEqual([]);
  });

  it('extracts a markdown image with plain absolute path', () => {
    const segments = parseOutboundSegments(
      'look:\n![shot](/tmp/foo.png)\nnice',
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'look:' },
      { kind: 'attachment', filePath: '/tmp/foo.png' },
      { kind: 'text', text: 'nice' },
    ]);
  });

  it('extracts a markdown image with a file:// URL', () => {
    const segments = parseOutboundSegments('![](file:///tmp/bar.jpg)');
    expect(segments).toEqual([
      { kind: 'attachment', filePath: '/tmp/bar.jpg' },
    ]);
  });

  it('extracts <file:...> markers and preserves ordering', () => {
    const segments = parseOutboundSegments(
      'first <file:/tmp/a.pdf> then <file:/tmp/b.png> done',
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'attachment', filePath: '/tmp/a.pdf' },
      { kind: 'text', text: 'then' },
      { kind: 'attachment', filePath: '/tmp/b.png' },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('ignores non-absolute paths', () => {
    const segments = parseOutboundSegments('![](relative.png) hi');
    expect(segments).toEqual([{ kind: 'text', text: '![](relative.png) hi' }]);
  });

  it('keeps ~ paths (caller expands)', () => {
    const segments = parseOutboundSegments('<file:~/Workspace/x.png>');
    expect(segments).toEqual([
      { kind: 'attachment', filePath: '~/Workspace/x.png' },
    ]);
  });
});
