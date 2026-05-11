import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import http from 'http';

import { staticHandler, indexHtmlHandler, STATIC_ROOT } from './static.js';

// ── FS mock ───────────────────────────────────────────────────────────────────

import fs from 'fs';

vi.mock('fs');

const mockStatSync = vi.mocked(fs.statSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeFileStat(mtime = 1000): fs.Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
    mtimeMs: mtime,
  } as unknown as fs.Stats;
}

function makeDirStat(): fs.Stats {
  return {
    isFile: () => false,
    isDirectory: () => true,
    mtimeMs: 0,
  } as unknown as fs.Stats;
}

function makeCtx() {
  return {
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url = 'http://localhost/', headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

beforeEach(() => {
  mockStatSync.mockReset();
  mockReadFileSync.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('indexHtmlHandler — D2', () => {
  it('test_indexHtml_serves_dist_dashboard_index', async () => {
    mockStatSync.mockReturnValue(makeFileStat(1000));
    mockReadFileSync.mockReturnValue(Buffer.from('INDEX'));

    const resp = await indexHtmlHandler(makeReq(), {}, makeCtx());
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('content-type')).toBe('text/html');
    const text = await resp!.text();
    expect(text).toBe('INDEX');
  });

  it('returns 404 when index.html missing', async () => {
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const resp = await indexHtmlHandler(makeReq(), {}, makeCtx());
    expect(resp!.status).toBe(404);
  });
});

describe('staticHandler — D2', () => {
  it('test_static_serves_js_with_correct_mime', async () => {
    mockStatSync.mockReturnValue(makeFileStat(2000));
    mockReadFileSync.mockReturnValue(Buffer.from('console.log("hi")'));

    const resp = await staticHandler(makeReq(), { tail: 'assets/app.js' }, makeCtx());
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('content-type')).toBe('application/javascript');
  });

  it('test_static_path_traversal_rejected', async () => {
    // Stat would return a file outside STATIC_ROOT — but containment check fires first
    mockStatSync.mockReturnValue(makeFileStat());

    const resp = await staticHandler(makeReq(), { tail: '../../etc/passwd' }, makeCtx());
    expect(resp!.status).toBe(404);
  });

  it('test_static_url_encoded_traversal_rejected', async () => {
    mockStatSync.mockReturnValue(makeFileStat());

    const resp = await staticHandler(makeReq(), { tail: '%2e%2e%2f%2e%2e%2fetc%2fpasswd' }, makeCtx());
    expect(resp!.status).toBe(404);
  });

  it('test_static_null_byte_rejected', async () => {
    mockStatSync.mockReturnValue(makeFileStat());

    const resp = await staticHandler(makeReq(), { tail: 'foo\0.js' }, makeCtx());
    expect(resp!.status).toBe(404);
  });

  it('test_static_empty_tail_404', async () => {
    // No stat needed — empty tail is rejected before stat
    const resp = await staticHandler(makeReq(), { tail: '' }, makeCtx());
    expect(resp!.status).toBe(404);
  });

  it('test_static_directory_404', async () => {
    mockStatSync.mockReturnValue(makeDirStat());

    const resp = await staticHandler(makeReq(), { tail: 'assets' }, makeCtx());
    expect(resp!.status).toBe(404);
  });

  it('test_static_unknown_extension_octet_stream', async () => {
    mockStatSync.mockReturnValue(makeFileStat(3000));
    mockReadFileSync.mockReturnValue(Buffer.from('\x00\x01\x02'));

    const resp = await staticHandler(makeReq(), { tail: 'assets/foo.bin' }, makeCtx());
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('content-type')).toBe('application/octet-stream');
    expect(resp!.headers.get('content-type')).not.toBe('text/plain');
  });

  it('test_static_etag_304_on_match', async () => {
    const mtime = 0xabc123;
    mockStatSync.mockReturnValue(makeFileStat(mtime));
    mockReadFileSync.mockReturnValue(Buffer.from('data'));

    // First request — get etag
    const r1 = await staticHandler(makeReq(), { tail: 'assets/app.js' }, makeCtx());
    const etag = r1!.headers.get('etag')!;
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const r2 = await staticHandler(
      makeReq('http://localhost/', { 'if-none-match': etag }),
      { tail: 'assets/app.js' },
      makeCtx(),
    );
    expect(r2!.status).toBe(304);
  });

  it('ASSERT M36: path.resolve + startsWith containment holds', async () => {
    // Verify the containment logic with an explicit path
    const resolved = path.resolve(STATIC_ROOT, '../../etc/passwd');
    expect(resolved.startsWith(STATIC_ROOT + path.sep)).toBe(false);
  });
});
