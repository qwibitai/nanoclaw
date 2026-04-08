/**
 * Static asset handler for the dashboard-web Vite bundle.
 *
 * Serves GET /dashboard/assets/<filename> from the Vite build output at
 * nanoclaw/dashboard-web/dist/assets/. Tailscale source check is
 * enforced upstream in ios.ts:handleHttp before this handler runs, so
 * there is no per-request source check here.
 *
 * Security contract:
 *   - Path-containment: the resolved file path must live strictly
 *     inside dist/assets/. Any traversal variant (%2e%2e, absolute
 *     path, backslash, symlink) is rejected with 403.
 *   - URL parsing via `new URL(...)` decodes once; we do NOT
 *     `decodeURIComponent` the path a second time (that would open a
 *     %252e-style double-encoding bypass).
 *   - Null bytes and control characters are rejected outright.
 *   - Symlinks are resolved with fs.realpathSync before the containment
 *     check.
 *
 * Cache-Control: Vite hashes filenames (e.g. index-RfbVBMFL.js), so
 * assets are immutable by content. Long max-age + immutable directive
 * is safe and desirable.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dashboard-web/dist',
);
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const ASSETS_PREFIX = '/dashboard/assets/';

// Resolve the real path of ASSETS_DIR once at module load so symlink
// resolution in the per-request check can compare against it.
let REAL_ASSETS_DIR: string | null = null;
try {
  REAL_ASSETS_DIR = fs.realpathSync(ASSETS_DIR);
} catch {
  // Build output may not exist yet at first module load; per-request
  // stat will surface the error then.
  REAL_ASSETS_DIR = null;
}

/**
 * Content type by extension. The set is intentionally narrow — Vite's
 * emitted assets are almost always JS, CSS, SVG, or font files.
 * Anything unrecognized is served as application/octet-stream.
 */
function contentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

/** Reject any path containing null bytes or ASCII control characters. */
function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(s);
}

/**
 * Handle GET /dashboard/assets/<file>. Returns true if matched.
 * Also handles the dashboard's public/ assets (favicon, etc.) at
 * /dashboard/<filename> by falling back to DIST_DIR. We keep the
 * primary path-containment check on ASSETS_DIR for hashed assets and
 * use a narrow explicit allowlist for the public root.
 */
export function handleDashboardAssets(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== 'GET') return false;

  const rawUrl = req.url;
  if (!rawUrl) return false;

  // Parse once. `new URL` decodes percent-encoding and rejects null
  // bytes at the URL-parse layer on modern Node.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://localhost');
  } catch {
    return false;
  }
  const pathname = parsed.pathname;

  // Defense in depth: any control character in the decoded pathname is
  // a hard reject, even if `new URL` let it through.
  if (hasControlChars(pathname)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }

  // --- /dashboard/assets/<hashed-asset> --------------------------------
  if (pathname.startsWith(ASSETS_PREFIX)) {
    const relative = pathname.slice(ASSETS_PREFIX.length);

    // Reject empty, `..`-containing, or backslash-containing paths up
    // front. The resolve+realpath check below would catch most of
    // these, but rejecting early keeps the error path obvious.
    if (
      relative === '' ||
      relative.includes('..') ||
      relative.includes('\\') ||
      relative.startsWith('/')
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }

    const resolved = path.resolve(ASSETS_DIR, relative);

    // Containment check 1: the resolved path must start with ASSETS_DIR.
    if (!resolved.startsWith(ASSETS_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }

    // Containment check 2: after symlink resolution, the real path
    // must ALSO be inside the real ASSETS_DIR.
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return true;
    }

    // REAL_ASSETS_DIR may be null if dist/ didn't exist at module load;
    // try once more on the fly. If it still doesn't exist, 404.
    if (REAL_ASSETS_DIR === null) {
      try {
        REAL_ASSETS_DIR = fs.realpathSync(ASSETS_DIR);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Dashboard build output not found');
        return true;
      }
    }

    if (!realPath.startsWith(REAL_ASSETS_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }

    // Stat + stream. We buffer-read small assets; Vite bundles are
    // typically <1MB so this is fine and simpler than streaming.
    let body: Buffer;
    try {
      body = fs.readFileSync(realPath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return true;
    }

    res.writeHead(200, {
      'Content-Type': contentType(realPath),
      'Content-Length': body.length,
      // Vite hashes filenames. Long-cache + immutable is safe.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(body);
    return true;
  }

  // --- /dashboard/favicon.svg (and any other public/ root files) -------
  //
  // Vite copies files under public/ to dist/ at build time, so the
  // favicon lives at dist/favicon.svg (not dist/assets/). We serve it
  // from DIST_DIR directly with the same containment discipline but a
  // narrow allowlist — no arbitrary traversal into dist/.
  //
  // IMPORTANT: explicitly skip /dashboard/api/* and /dashboard/events
  // before the regex match. The character class `[a-zA-Z0-9_.-]+` is
  // tight, but `events` is a valid match and would shadow the SSE
  // endpoint if anyone ever drops a file named `events` (or `api`)
  // into dashboard-web/public/. Vite would copy it to dist/ and this
  // handler would happily serve it instead of falling through to
  // handleDashboardApi. Better to fail closed.
  if (
    pathname === '/dashboard/events' ||
    pathname.startsWith('/dashboard/api/')
  ) {
    return false;
  }
  const publicMatch = pathname.match(/^\/dashboard\/([a-zA-Z0-9_.-]+)$/);
  if (publicMatch) {
    const filename = publicMatch[1];
    // Redundant but explicit: `[a-zA-Z0-9_.-]+` already excludes `/`
    // and `..` tokens, but belt-and-braces.
    if (
      filename === '' ||
      filename.startsWith('.') ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      return false;
    }

    const resolved = path.resolve(DIST_DIR, filename);
    if (!resolved.startsWith(DIST_DIR + path.sep)) {
      return false;
    }

    // Not all /dashboard/<filename> requests are for public assets;
    // /dashboard and /dashboard/ themselves are handled by
    // handleDashboardPage and must not be swallowed here. The regex
    // above excludes those, but double-check with a file existence
    // guard so a miss falls through to the next handler.
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return false;
    }

    let body: Buffer;
    try {
      body = fs.readFileSync(resolved);
    } catch {
      return false;
    }

    res.writeHead(200, {
      'Content-Type': contentType(resolved),
      'Content-Length': body.length,
      // Public-root files aren't hashed — shorter cache.
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(body);
    return true;
  }

  return false;
}
