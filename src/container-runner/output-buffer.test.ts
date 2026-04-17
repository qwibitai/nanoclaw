import { describe, expect, it } from 'vitest';

import { TruncatingBuffer } from './output-buffer.js';

describe('TruncatingBuffer', () => {
  it('collects text under the limit', () => {
    const buf = new TruncatingBuffer(100);
    buf.append('hello ');
    buf.append('world');
    expect(buf.text).toBe('hello world');
    expect(buf.wasTruncated).toBe(false);
    expect(buf.length).toBe(11);
  });

  it('truncates at exactly the limit', () => {
    const buf = new TruncatingBuffer(5);
    buf.append('hello');
    expect(buf.text).toBe('hello');
    expect(buf.wasTruncated).toBe(false);
  });

  it('marks truncated and drops the tail when a chunk overflows', () => {
    const buf = new TruncatingBuffer(5);
    buf.append('hello world');
    expect(buf.text).toBe('hello');
    expect(buf.wasTruncated).toBe(true);
  });

  it('keeps the head when a later chunk overflows', () => {
    const buf = new TruncatingBuffer(10);
    buf.append('abcd');
    buf.append('efghijklmno');
    expect(buf.text).toBe('abcdefghij');
    expect(buf.wasTruncated).toBe(true);
  });

  it('ignores further appends once truncated', () => {
    const buf = new TruncatingBuffer(5);
    buf.append('hello world'); // truncates
    buf.append('more');
    expect(buf.text).toBe('hello');
    expect(buf.wasTruncated).toBe(true);
  });
});
