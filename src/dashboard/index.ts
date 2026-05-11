/**
 * Dashboard bootstrap.
 *
 * Wire-up site for all dashboard routes. Groups C and D register their
 * handlers here; Group A's router enforces first-match dispatch so API
 * routes must be registered before the static splat catch-all.
 */
import { register, requireAuth, registerCookieVerifier } from './router.js';
import { ensureServerStarted } from '../webhook-server.js';
import { startSSEFeed, stopSSEFeed, eventsHandler } from './api/events.js';
import { indexHtmlHandler, staticHandler } from './static.js';
import { tasksListHandler, tasksDetailHandler } from './api/tasks.js';
import { sessionsHandler } from './api/sessions.js';
import { steerHandler } from './steer.js';

// Side-effect imports — these files register their routes/handlers at module load
import './auth/exchange.js';               // POST /dashboard/api/auth/exchange
import './api/auth-me.js';                 // GET /dashboard/api/auth/me
import './auth/dashboard-token-issue.js';  // registers 'dashboard_token_issue' intercept handler

let started = false;

export function startDashboard(): void {
  if (started) return;
  started = true;

  // Wire cookie verifier — B5 (auth/cookie.ts) ships the real implementation.
  import('./auth/cookie.js')
    .then((cookieMod) => {
      const serverKey = cookieMod.resolveServerKey();
      registerCookieVerifier((cookieHeader) =>
        cookieMod.parseAndVerifyCookie(cookieHeader, serverKey),
      );
    })
    .catch((err) => {
      console.error('Failed to wire cookie verifier', err);
    });

  // SSE feed lifecycle
  startSSEFeed();

  // Auth-gated API routes (requireAuth wrap):
  register('GET', '/dashboard/api/events', requireAuth(eventsHandler));
  register('GET', '/dashboard/api/tasks', requireAuth(tasksListHandler));
  register('GET', '/dashboard/api/tasks/:id', requireAuth(tasksDetailHandler));
  register('GET', '/dashboard/api/sessions', requireAuth(sessionsHandler));
  register('POST', '/dashboard/api/tasks/:id/message', requireAuth(steerHandler));

  // Static assets — public, no auth (design §6). Splat must be LAST.
  register('GET', '/dashboard/', indexHtmlHandler);
  register('GET', '/dashboard/static/*tail', staticHandler);

  ensureServerStarted();
}

export function stopDashboard(): void {
  stopSSEFeed();
}
