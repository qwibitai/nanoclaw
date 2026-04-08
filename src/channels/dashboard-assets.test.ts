/**
 * Tests for the dashboard-assets static file handler.
 *
 * Path-traversal coverage is the reason this file exists. The handler
 * resolves paths against nanoclaw/dashboard-web/dist/ and any bypass
 * would let a Tailscale-reachable caller read arbitrary files from the
 * nanoclaw project tree — or worse, from anywhere readable by the
 * nanoclaw process user. These tests pin the contract against every
 * traversal variant we could think of.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleDashboardAssets } from './dashboard-assets.js';

/**
 * Helper: build a fake req/res pair, run the handler, return what got
 * written. We don't spin up a real HTTP server because we just want to
 * exercise the handler function against specific URL shapes.
 */
function runHandler(url: string): {
  handled: boolean;
  statusCode: number;
  body: Buffer;
  headers: Record<string, string | number | undefined>;
} {
  const req = {
    method: 'GET',
    url,
  } as unknown as http.IncomingMessage;

  let statusCode = 0;
  const chunks: Buffer[] = [];
  const headers: Record<string, string | number | undefined> = {};

  const res = {
    writeHead(code: number, h?: Record<string, string | number>) {
      statusCode = code;
      if (h) Object.assign(headers, h);
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    },
  } as unknown as http.ServerResponse;

  const handled = handleDashboardAssets(req, res);
  return { handled, statusCode, body: Buffer.concat(chunks), headers };
}

describe('handleDashboardAssets', () => {
  // --- Non-match cases --------------------------------------------------

  it('returns false for non-GET requests', () => {
    const req = {
      method: 'POST',
      url: '/dashboard/assets/foo.js',
    } as unknown as http.IncomingMessage;
    const res = {
      writeHead() {},
      end() {},
    } as unknown as http.ServerResponse;
    expect(handleDashboardAssets(req, res)).toBe(false);
  });

  it('returns false for paths outside /dashboard/', () => {
    const result = runHandler('/api/health');
    expect(result.handled).toBe(false);
  });

  it('returns false for /dashboard and /dashboard/ (handleDashboardPage owns those)', () => {
    expect(runHandler('/dashboard').handled).toBe(false);
    expect(runHandler('/dashboard/').handled).toBe(false);
  });

  // --- Path-traversal variants — must never return 200 with out-of-tree bytes -----
  //
  // The security property these tests pin: for any traversal URL, the
  // handler must not serve a 200 response containing file contents
  // from outside dist/assets/. The _how_ varies — URL() parsing
  // normalizes some segments to a non-matching route, some variants
  // hit the explicit `..` / `\\` / `/` rejection, others hit the
  // resolve+containment check, and a few fall through to 404 when the
  // normalized path points at a non-existent file. All of those
  // outcomes are safe. The tests below assert "not 200" rather than a
  // specific error code so a change in URL normalization behavior
  // doesn't produce a false alarm as long as the invariant holds.

  function assertSafe(url: string) {
    const result = runHandler(url);
    if (result.handled) {
      // Any 4xx or 5xx is safe. 200 is the red flag.
      expect(result.statusCode).not.toBe(200);
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    }
    // If not handled, upstream dispatcher continues and ultimately
    // returns its own 404. Still safe.
  }

  describe('path-traversal defense', () => {
    it('rejects literal ../ traversal', () => {
      assertSafe('/dashboard/assets/../package.json');
    });

    it('rejects URL-encoded ../ traversal (%2e%2e%2f)', () => {
      assertSafe('/dashboard/assets/%2e%2e%2fpackage.json');
    });

    it('rejects mixed-case URL-encoded traversal (%2E%2E)', () => {
      assertSafe('/dashboard/assets/%2E%2E/package.json');
    });

    it('rejects single-segment encoded (..%2f)', () => {
      assertSafe('/dashboard/assets/..%2fpackage.json');
    });

    it('rejects backslash separator', () => {
      assertSafe('/dashboard/assets/..\\package.json');
    });

    it('rejects absolute-path injection via //', () => {
      assertSafe('/dashboard/assets//etc/passwd');
    });

    it('rejects empty asset path', () => {
      assertSafe('/dashboard/assets/');
    });

    it('rejects paths with null bytes', () => {
      assertSafe('/dashboard/assets/index.js\x00.png');
    });

    it('rejects deep traversal past dist/', () => {
      assertSafe('/dashboard/assets/../../etc/passwd');
      assertSafe('/dashboard/assets/../../../etc/passwd');
    });

    it('rejects traversal through a valid prefix', () => {
      assertSafe('/dashboard/assets/foo/../../package.json');
    });
  });

  // --- Traversal via symlink -------------------------------------------

  describe('symlink traversal defense', () => {
    let tmpOutsideFile: string | null = null;
    let symlinkInsideAssets: string | null = null;

    beforeAll(() => {
      // Create a file outside dist/ that a symlink inside dist/assets/
      // will point to. Then create the symlink. The handler must
      // reject the symlinked request because realpath resolves it out
      // of bounds.
      const distDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../dashboard-web/dist',
      );
      const assetsDir = path.join(distDir, 'assets');

      if (!fs.existsSync(assetsDir)) {
        // Build hasn't run — skip the symlink test. The other tests
        // still catch the 99% case.
        return;
      }

      try {
        tmpOutsideFile = path.join(
          os.tmpdir(),
          `nanoclaw-symlink-target-${process.pid}.txt`,
        );
        fs.writeFileSync(tmpOutsideFile, 'secret contents');

        symlinkInsideAssets = path.join(assetsDir, 'symlink-out.txt');
        // Remove any leftover from a previous run.
        try {
          fs.unlinkSync(symlinkInsideAssets);
        } catch {
          // ignore
        }
        fs.symlinkSync(tmpOutsideFile, symlinkInsideAssets);
      } catch {
        // Filesystem doesn't support symlinks, or we're in a sandbox.
        // Skip this test — we still have the explicit ../ checks.
        tmpOutsideFile = null;
        symlinkInsideAssets = null;
      }
    });

    afterAll(() => {
      if (symlinkInsideAssets) {
        try {
          fs.unlinkSync(symlinkInsideAssets);
        } catch {
          // ignore
        }
      }
      if (tmpOutsideFile) {
        try {
          fs.unlinkSync(tmpOutsideFile);
        } catch {
          // ignore
        }
      }
    });

    it('rejects a symlink that points outside dist/assets/', () => {
      if (!symlinkInsideAssets) {
        // Skip — symlink creation failed in setup
        return;
      }
      const result = runHandler('/dashboard/assets/symlink-out.txt');
      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(403);
    });
  });

  // --- Happy path -------------------------------------------------------
  //
  // These tests require the build output to exist. If it doesn't, we
  // skip cleanly — Unit 3's full build chain covers this end-to-end.

  describe('happy path (requires dashboard-web build)', () => {
    const distDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../dashboard-web/dist',
    );
    const assetsDir = path.join(distDir, 'assets');
    const buildExists = fs.existsSync(assetsDir);

    it('serves a real hashed asset with the expected headers', () => {
      if (!buildExists) return;

      // Find any emitted .js asset.
      const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
      if (files.length === 0) return;

      const result = runHandler(`/dashboard/assets/${files[0]}`);
      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe(
        'application/javascript; charset=utf-8',
      );
      expect(result.headers['Cache-Control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(result.body.length).toBeGreaterThan(0);
    });

    it('returns 404 for a non-existent hashed asset', () => {
      if (!buildExists) return;
      const result = runHandler(
        '/dashboard/assets/this-does-not-exist-abc123.js',
      );
      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(404);
    });

    it('serves /dashboard/favicon.svg from dist/ public root', () => {
      if (!buildExists) return;
      if (!fs.existsSync(path.join(distDir, 'favicon.svg'))) return;
      const result = runHandler('/dashboard/favicon.svg');
      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('image/svg+xml');
    });
  });
});
