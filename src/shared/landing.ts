/**
 * Shared landing page builder for Nexus processes.
 * Both gateway and store use this to render a consistent home page.
 */

import { APP_VERSION, ASSISTANT_NAME, OPERATOR_NAME } from './config.ts';

interface ProcessInfo {
  name: string;
  port: number;
  role: string;
  listens: boolean;
}

const processes: ProcessInfo[] = [
  { name: 'Gateway', port: 3001, role: 'Receives messages from Discord, web chat. Routes to agent via work queue.', listens: true },
  { name: 'Agent', port: 0, role: 'Runs Claude Agent SDK. Processes messages with skills and knowledge.', listens: false },
  { name: 'Store', port: 3002, role: 'Persists sessions, conversation history, and scheduled tasks.', listens: true },
];

export function buildLandingPage(currentProcess: string, currentPort: number): string {
  const rows = processes.map((p) => {
    const isCurrent = p.name === currentProcess;
    const rowClass = isCurrent ? ' class="current"' : '';
    const pad = isCurrent ? 'padding: 0.4rem 0.3rem;' : '';

    let nameCell: string;
    if (isCurrent) {
      nameCell = p.name;
    } else if (p.listens) {
      nameCell = `<a href="http://localhost:${p.port}/">${p.name}</a>`;
    } else {
      nameCell = p.name;
    }

    const portCell = p.listens ? `${p.port}` : '—';

    return `<tr${rowClass}><td style="${pad}">${nameCell}</td><td style="${pad}">${portCell}</td><td style="${pad}">${p.role}</td></tr>`;
  }).join('\n      ');

  const footer = currentProcess === 'Gateway'
    ? '<a href="/licenses">Licenses</a>'
    : 'Simtricity Nexus';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${currentProcess} — ${OPERATOR_NAME}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f4; color: #1c1917; }
    .container { max-width: 540px; padding: 2rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin: 0; text-align: center; }
    .meta { text-align: center; margin: 0.25rem 0 1.5rem; }
    .meta span { color: #78716c; font-size: 0.85rem; }
    .meta span + span::before { content: " · "; }
    .badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 0.5rem; }
    th { text-align: left; color: #78716c; font-weight: 500; padding: 0.4rem 0; border-bottom: 1px solid #d6d3d1; }
    td { padding: 0.4rem 0; border-bottom: 1px solid #e7e5e4; }
    td:first-child { font-weight: 600; white-space: nowrap; }
    td:nth-child(2) { font-family: monospace; font-size: 0.75rem; color: #78716c; white-space: nowrap; width: 3rem; }
    .current { background: #fef3c7; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: #a8a29e; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${ASSISTANT_NAME}</h1>
    <div class="meta">
      <span>${OPERATOR_NAME}</span>
      <span>Simtricity Nexus Agent Platform</span>
      <span class="badge">v${APP_VERSION}</span>
    </div>
    <table>
      <tr><th>Process</th><th>Port</th><th>Role</th></tr>
      ${rows}
    </table>
    <div class="footer">${footer}</div>
  </div>
</body>
</html>`;
}
