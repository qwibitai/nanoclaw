/**
 * NanoClaw Web Dashboard — unified SPA for vault, meals, tasks, dev tasks.
 * No auth — Tailscale is the access layer.
 *
 * Client-side rendered SPA: server delivers HTML shell with inline JS,
 * views fetch data from /dashboard/api/* endpoints and render client-side.
 */

import http from 'http';
import { getDashboardCSS } from './dashboard-css.js';
import { getVaultViewHTML, getVaultViewJS } from './dashboard-vault-view.js';
import { getMealsViewHTML, getMealsViewJS } from './dashboard-meals-view.js';
import { getTasksViewHTML, getTasksViewJS } from './dashboard-tasks-view.js';
import {
  getDevTasksViewHTML,
  getDevTasksViewJS,
} from './dashboard-devtasks-view.js';

const NAV_ITEMS = [
  { id: 'vault', label: 'Vault', icon: 'vault' },
  { id: 'meals', label: 'Meal Plan', icon: 'meals' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'devtasks', label: 'Dev Tasks', icon: 'devtasks' },
] as const;

const ICONS: Record<string, string> = {
  vault:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  meals:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>',
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  devtasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNavItems(type: 'sidebar' | 'tabbar'): string {
  const cls = type === 'sidebar' ? 'nav-item' : 'tab-item';
  return NAV_ITEMS.map(
    (item) =>
      `<button class="${cls}" data-view="${item.id}">${ICONS[item.icon]}<span>${esc(item.label)}</span></button>`,
  ).join('\n');
}

function renderPage(): string {
  const css = getDashboardCSS();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>NanoClaw Dashboard</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>${css}</style>
</head>
<body>

<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>NanoClaw</h1>
      <div class="subtitle"><span class="connection-dot"></span>Live</div>
    </div>
    <nav>
      ${renderNavItems('sidebar')}
    </nav>
  </aside>

  <main class="main">
    <section id="view-vault" class="view">
      ${getVaultViewHTML()}
    </section>
    <section id="view-meals" class="view">
      ${getMealsViewHTML()}
    </section>
    <section id="view-tasks" class="view">
      ${getTasksViewHTML()}
    </section>
    <section id="view-devtasks" class="view">
      ${getDevTasksViewHTML()}
    </section>
  </main>
</div>

<div class="tab-bar">
  <nav>
    ${renderNavItems('tabbar')}
  </nav>
</div>

<script>
// --- Hash Router ---
const VIEWS = ['vault', 'meals', 'tasks', 'devtasks'];

function navigate(viewId) {
  if (!VIEWS.includes(viewId)) viewId = 'vault';
  location.hash = viewId;

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + viewId);
  if (target) target.classList.add('active');

  // Update nav
  document.querySelectorAll('.nav-item, .tab-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  // Dispatch event for views that need to know when they become active
  window.dispatchEvent(new CustomEvent('viewchange', { detail: { view: viewId } }));
}

// Nav click handlers
document.querySelectorAll('.nav-item, .tab-item').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

// Handle initial hash or default
const initialHash = location.hash.slice(1);
navigate(initialHash || 'vault');

// Handle hash changes (back/forward)
window.addEventListener('hashchange', () => {
  navigate(location.hash.slice(1));
});

// --- SSE Connection ---
let sseConnected = false;

function connectSSE() {
  const es = new EventSource('/dashboard/events');

  es.onopen = function() {
    sseConnected = true;
    document.querySelectorAll('.connection-dot').forEach(d => d.classList.remove('disconnected'));
  };

  es.onmessage = function(e) {
    try {
      const data = JSON.parse(e.data);
      if (data.type) {
        window.dispatchEvent(new CustomEvent('dashboard-' + data.type));
      }
    } catch {
      // Simple string messages like 'connected'
    }
  };

  es.onerror = function() {
    sseConnected = false;
    document.querySelectorAll('.connection-dot').forEach(d => d.classList.add('disconnected'));
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

connectSSE();
</script>

<script>
${getVaultViewJS()}
</script>

<script>
${getMealsViewJS()}
</script>

<script>
${getTasksViewJS()}
</script>

<script>
${getDevTasksViewJS()}
</script>

</body>
</html>`;
}

/** Handle GET /dashboard and /dashboard/* routes. Returns true if matched. */
export function handleDashboardPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== 'GET') return false;

  const url = req.url?.split('?')[0] || '';

  // Match /dashboard exactly, or /dashboard/ with trailing slash
  if (url === '/dashboard' || url === '/dashboard/') {
    const html = renderPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      // Defense-in-depth against a hypothetical sanitizer bypass in the
      // report renderer. The dashboard uses inline <script> blocks for its
      // views (vault, meals, tasks, devtasks, reports), so 'unsafe-inline'
      // is required for now. The report body never contains <script> (both
      // marked's HTML passthrough is off and sanitize-html strips it), so
      // the practical attack surface is narrow — but CSP still rules out
      // external script loads beyond d3 and object/base-uri tricks.
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://d3js.org",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    res.end(html);
    return true;
  }

  return false;
}
