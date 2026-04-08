/**
 * NanoClaw Web Dashboard — shell loader for the dashboard-web SPA.
 *
 * No auth — Tailscale is the access layer (enforced upstream in ios.ts
 * by the isAllowedSource source check; see handleHttp).
 *
 * The old hand-rolled HTML/CSS/JS that used to live here has been
 * replaced by a React + Vite + shadcn/ui SPA built out of
 * nanoclaw/dashboard-web/. This file just serves the built index.html
 * shell for /dashboard and /dashboard/. Static assets emitted by Vite
 * (hashed JS/CSS under dist/assets/) are served by the sibling
 * handleDashboardAssets in ./dashboard-assets.ts.
 *
 * Report content is still sanitized server-side in
 * ./dashboard-report-render.ts and reaches the client as opaque
 * body_html — the React app renders it via dangerouslySetInnerHTML
 * against a branded SanitizedHtml type so the security boundary
 * stays in exactly one place.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';

/**
 * Resolve nanoclaw/dashboard-web/dist/index.html relative to this file's
 * compiled location. At runtime, `import.meta.url` points into
 * nanoclaw/dist/channels/dashboard-page.js (nanoclaw ships `"type":
 * "module"` and `tsc` emits the source tree preserved under dist/). Two
 * `..` levels walk back to nanoclaw/, then into dashboard-web/dist.
 *
 * Computed once at module load, not per request.
 */
const DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dashboard-web/dist',
);
const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');

/**
 * Content Security Policy for the dashboard shell.
 *
 * Tightened from the previous hand-rolled dashboard:
 *   - `'unsafe-inline'` DROPPED from script-src. Vite bundles everything
 *     into hashed script files under /dashboard/assets/; there are no
 *     inline <script> blocks in the served HTML.
 *   - `https://d3js.org` DROPPED. D3 (force, selection, zoom, drag
 *     submodules only) is bundled into the Vite output.
 *   - `'unsafe-inline'` retained in style-src: Tailwind emits a single
 *     stylesheet but Radix primitives (via shadcn) use inline style
 *     attributes for animations and theme variables. Dropping this
 *     requires nonces, which is a separate tightening pass.
 *
 * Report HTML is sanitized in dashboard-report-render.ts (marked +
 * sanitize-html with a narrow allowlist) and never contains <script>;
 * the sanitizer stays the security boundary of record.
 */
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// --- index.html mtime cache ---

let cachedHtml: string | null = null;
let cachedMtimeMs = 0;

/**
 * Read dist/index.html with an mtime-based cache so a fresh `vite build`
 * is picked up without restarting nanoclaw. The file is small (<1kb) and
 * stat is cheap; one stat per dashboard load is negligible.
 *
 * Returns null if the build output is missing — the caller responds 500
 * with a clear error so first-deploy build misses are loud.
 */
function readIndexHtml(): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(INDEX_HTML_PATH);
  } catch {
    return null;
  }

  if (cachedHtml !== null && stat.mtimeMs === cachedMtimeMs) {
    return cachedHtml;
  }

  try {
    cachedHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
    cachedMtimeMs = stat.mtimeMs;
    return cachedHtml;
  } catch {
    return null;
  }
}

// --- Startup existence check ---
//
// Logged loudly once at module load if the build output is missing. This
// catches the first-deploy-without-build case immediately instead of at
// the first HTTP request, where it would surface as an opaque 500.
if (!fs.existsSync(INDEX_HTML_PATH)) {
  logger.error(
    { path: INDEX_HTML_PATH },
    'dashboard-web build output not found — run `npm run build` from the nanoclaw root',
  );
}

/** Handle GET /dashboard and /dashboard/. Returns true if matched. */
export function handleDashboardPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== 'GET') return false;

  const url = req.url?.split('?')[0] || '';

  if (url !== '/dashboard' && url !== '/dashboard/') return false;

  const html = readIndexHtml();
  if (html === null) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'Dashboard build not found. Run `npm run build` in nanoclaw/ to build dashboard-web.',
    );
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP_HEADER,
  });
  res.end(html);
  return true;
}
