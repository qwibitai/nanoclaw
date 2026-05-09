import { describe, expect, it } from 'bun:test';

import { normalizeMcpEntry } from './mcp-config.js';

describe('normalizeMcpEntry', () => {
  it('passes stdio through (legacy supergateway shape)', () => {
    const out = normalizeMcpEntry('qmd-public', {
      command: 'npx',
      args: ['-y', 'supergateway', '--streamableHttp', 'http://host.docker.internal:7333/mcp', '--logLevel', 'none'],
    });
    expect(out).toEqual({
      command: 'npx',
      args: ['-y', 'supergateway', '--streamableHttp', 'http://host.docker.internal:7333/mcp', '--logLevel', 'none'],
    });
  });

  it("preserves explicit type:'stdio'", () => {
    const out = normalizeMcpEntry('foo', { type: 'stdio', command: 'bun', args: ['run', 'x.ts'] });
    expect(out).toEqual({ type: 'stdio', command: 'bun', args: ['run', 'x.ts'] });
  });

  it("normalizes 'streamableHttp' to SDK 'http'", () => {
    const out = normalizeMcpEntry('qmd-public', {
      type: 'streamableHttp',
      url: 'http://host.docker.internal:7333/mcp',
    });
    expect(out).toEqual({ type: 'http', url: 'http://host.docker.internal:7333/mcp' });
  });

  it('passes http through unchanged', () => {
    const out = normalizeMcpEntry('q', { type: 'http', url: 'http://x' });
    expect(out).toEqual({ type: 'http', url: 'http://x' });
  });

  it('passes sse through unchanged', () => {
    const out = normalizeMcpEntry('q', { type: 'sse', url: 'http://x' });
    expect(out).toEqual({ type: 'sse', url: 'http://x' });
  });

  it('preserves headers on URL transports', () => {
    const out = normalizeMcpEntry('q', {
      type: 'streamableHttp',
      url: 'http://x',
      headers: { Authorization: 'Bearer a' },
    });
    expect(out).toEqual({ type: 'http', url: 'http://x', headers: { Authorization: 'Bearer a' } });
  });

  it('drops host-only `instructions` field', () => {
    const out = normalizeMcpEntry('q', {
      type: 'streamableHttp',
      url: 'http://x',
      instructions: 'never reaches the SDK',
    } as Parameters<typeof normalizeMcpEntry>[1]);
    expect(out).toEqual({ type: 'http', url: 'http://x' });
  });

  it('throws on both command and url set', () => {
    expect(() => normalizeMcpEntry('bad', { command: 'npx', url: 'http://x' })).toThrow();
  });

  it('throws on neither command nor url', () => {
    expect(() => normalizeMcpEntry('bad', {})).toThrow();
  });

  it("throws on url with type 'stdio'", () => {
    expect(() => normalizeMcpEntry('bad', { type: 'stdio', url: 'http://x' })).toThrow();
  });
});
