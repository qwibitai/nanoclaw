import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ProjectRegistryEntry } from './symphony-routing.js';
import { listReadyIssuesForProject, type SymphonyLinearIssueSummary } from './symphony-linear.js';
import { loadProjectRegistryFromFile } from './symphony-registry.js';
import {
  buildRuntimeState,
  listRunRecords,
  readRunRecord,
  readRuntimeState,
  type SymphonyProjectRuntimeSummary,
  type SymphonyRunRecord,
} from './symphony-state.js';

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return 'Not recorded';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatRelativeDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 'Unknown duration';
  }
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function statusTone(status: string): string {
  switch (status) {
    case 'running':
    case 'done':
    case 'enabled':
      return 'good';
    case 'planned':
    case 'dispatching':
    case 'review':
      return 'warm';
    case 'blocked':
    case 'failed':
    case 'canceled':
      return 'bad';
    default:
      return 'muted';
  }
}

function renderBadge(label: string, tone = 'muted'): string {
  return `<span class="badge badge-${htmlEscape(tone)}">${htmlEscape(label)}</span>`;
}

function renderLink(url: string, label: string): string {
  return `<a href="${htmlEscape(url)}" target="_blank" rel="noreferrer">${htmlEscape(label)}</a>`;
}

function renderMetricCard(label: string, value: string, note: string): string {
  return `<article class="metric-card" data-metric-label="${htmlEscape(label)}">
  <div class="metric-label">${htmlEscape(label)}</div>
  <div class="metric-value">${htmlEscape(value)}</div>
  <div class="metric-note">${htmlEscape(note)}</div>
</article>`;
}

function readLogTail(filePath: string, maxChars = 3000): string {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return 'Log file not found.';
    }
    const text = fs.readFileSync(filePath, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch (error) {
    return `Unable to read log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function loadDashboardSnapshot(registryPath: string) {
  const registry = loadProjectRegistryFromFile(registryPath);
  const runtimeState =
    readRuntimeState() ||
    buildRuntimeState({
      registry,
      readyCounts: Object.fromEntries(
        registry.projects.map((project) => [project.projectKey, 0]),
      ),
      daemonHealthy: false,
    });
  const runs = listRunRecords();
  return { registry, runtimeState, runs };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function pageLayout(input: {
  title: string;
  kicker: string;
  heading: string;
  subheading: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>${htmlEscape(input.title)}</title>
  <style>
    :root {
      --ink: #24201b;
      --ink-soft: #655d54;
      --paper: #f7f4ed;
      --paper-strong: #fdfbf7;
      --line: rgba(53, 45, 36, 0.1);
      --line-strong: rgba(53, 45, 36, 0.16);
      --accent: rgb(255, 97, 26);
      --accent-soft: rgb(255, 150, 102);
      --olive: #315d54;
      --rose: #93443b;
      --amber: #8f622f;
      --shadow: 0 8px 24px rgba(89, 67, 38, 0.05);
      --radius-pill: 999px;
      --radius-card: 18px;
      --radius-panel: 16px;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
    }
    * { box-sizing: border-box; }
    html { color-scheme: light; }
    body {
      margin: 0;
      color: var(--ink);
      background: linear-gradient(180deg, #fbfaf6 0%, var(--paper) 100%);
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
      line-height: 1.42;
      min-height: 100vh;
    }
    a {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid rgba(255, 97, 26, 0.35);
      transition: border-color 0.3s var(--ease), color 0.3s var(--ease);
    }
    a:hover {
      color: var(--accent);
      border-color: rgba(255, 97, 26, 0.95);
    }
    code, pre {
      font-family: "SFMono-Regular", "Menlo", "Monaco", "Courier New", monospace;
    }
    .shell {
      width: min(1120px, calc(100vw - 28px));
      margin: 16px auto 36px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 20px 20px 18px;
      border-radius: 22px;
      border: 1px solid var(--line-strong);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(251, 248, 241, 0.96));
      box-shadow: var(--shadow);
    }
    .hero::after {
      display: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: var(--radius-pill);
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid rgba(255, 97, 26, 0.14);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 0.68rem;
      color: var(--ink-soft);
    }
    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, var(--accent-soft), var(--accent));
      box-shadow: 0 0 0 3px rgba(255, 97, 26, 0.08);
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: start;
      flex-wrap: wrap;
      position: relative;
      z-index: 1;
    }
    .hero-copy {
      max-width: 38rem;
    }
    .hero h1 {
      margin: 10px 0 6px;
      font-size: clamp(1.9rem, 4vw, 2.95rem);
      line-height: 0.98;
      font-weight: 600;
      letter-spacing: -0.04em;
    }
    .hero p {
      margin: 0;
      max-width: 34rem;
      font-size: 0.95rem;
      color: var(--ink-soft);
    }
    .hero-nav {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .nav-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: var(--radius-pill);
      background: rgba(255, 255, 255, 0.88);
      border: 1px solid var(--line);
      color: var(--ink-soft);
      font-size: 0.82rem;
    }
    .nav-pill strong {
      color: var(--ink);
      font-weight: 600;
    }
    .hero-grid,
    .card-grid,
    .run-grid,
    .detail-grid {
      display: grid;
      gap: 18px;
    }
    .hero-grid {
      margin-top: 18px;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      position: relative;
      z-index: 1;
    }
    .metric-card,
    .panel,
    .project-card,
    .run-card,
    .issue-card {
      background: rgba(255, 250, 243, 0.88);
      border: 1px solid var(--line);
      border-radius: var(--radius-card);
      box-shadow: 0 2px 10px rgba(89, 67, 38, 0.03);
    }
    .metric-card {
      padding: 14px 14px 12px;
    }
    .metric-label {
      font-size: 0.66rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-soft);
      margin-bottom: 8px;
    }
    .metric-value {
      font-size: clamp(1.3rem, 2.8vw, 1.9rem);
      line-height: 1.05;
      letter-spacing: -0.04em;
      margin-bottom: 6px;
      font-variant-numeric: tabular-nums;
    }
    .metric-note {
      color: var(--ink-soft);
      font-size: 0.83rem;
    }
    .section {
      margin-top: 18px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 14px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .section-title {
      margin: 0;
      font-size: clamp(1.05rem, 1.8vw, 1.35rem);
      letter-spacing: -0.02em;
    }
    .section-note {
      margin: 0;
      color: var(--ink-soft);
      font-size: 0.86rem;
      max-width: 52ch;
    }
    .card-grid {
      grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
    }
    .project-card,
    .run-card,
    .issue-card,
    .panel {
      padding: 16px;
    }
    .project-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: transform 0.35s var(--ease), box-shadow 0.35s var(--ease), border-color 0.35s var(--ease);
    }
    .project-card:hover,
    .run-card:hover,
    .issue-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 24px rgba(89, 67, 38, 0.07);
      border-color: rgba(255, 97, 26, 0.24);
    }
    .card-kicker {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .card-title {
      margin: 0;
      font-size: 1.08rem;
      line-height: 1.12;
      letter-spacing: -0.03em;
    }
    .card-copy {
      margin: 0;
      color: var(--ink-soft);
      font-size: 0.85rem;
    }
    .badge-row,
    .link-row,
    .meta-grid {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      padding: 4px 10px;
      border-radius: var(--radius-pill);
      font-size: 0.73rem;
      font-weight: 600;
      border: 1px solid transparent;
      text-transform: capitalize;
    }
    .badge-muted {
      color: var(--ink-soft);
      background: rgba(58, 48, 37, 0.06);
      border-color: rgba(58, 48, 37, 0.08);
    }
    .badge-good {
      color: var(--olive);
      background: rgba(45, 97, 86, 0.12);
      border-color: rgba(45, 97, 86, 0.18);
    }
    .badge-bad {
      color: var(--rose);
      background: rgba(161, 77, 66, 0.1);
      border-color: rgba(161, 77, 66, 0.18);
    }
    .badge-warm {
      color: var(--amber);
      background: rgba(148, 96, 45, 0.12);
      border-color: rgba(148, 96, 45, 0.18);
    }
    .mini-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .mini-metric {
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(58, 48, 37, 0.08);
    }
    .mini-label {
      font-size: 0.64rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-soft);
      margin-bottom: 6px;
    }
    .mini-value {
      font-size: 1rem;
      letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums;
    }
    .run-grid {
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    }
    .run-card,
    .issue-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .run-headline,
    .issue-headline {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      flex-wrap: wrap;
    }
    .mono {
      font-family: "SFMono-Regular", "Menlo", "Monaco", "Courier New", monospace;
      letter-spacing: -0.02em;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
    }
    .meta-item {
      padding: 10px 12px;
      background: rgba(58, 48, 37, 0.04);
      border-radius: 12px;
      border: 1px solid rgba(58, 48, 37, 0.06);
    }
    .meta-item strong {
      display: block;
      margin-bottom: 6px;
      font-size: 0.64rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-soft);
    }
    .detail-grid {
      grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
      align-items: start;
      margin-top: 18px;
    }
    .stack {
      display: grid;
      gap: 14px;
    }
    .log-panel {
      overflow: hidden;
    }
    pre.log-tail {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: #231f1b;
      color: #f7efe2;
      overflow: auto;
      max-height: 24rem;
      line-height: 1.4;
      font-size: 0.78rem;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
    }
    .empty-state {
      padding: 18px;
      border-radius: var(--radius-card);
      border: 1px dashed rgba(58, 48, 37, 0.18);
      background: rgba(255, 255, 255, 0.54);
      color: var(--ink-soft);
      font-size: 0.9rem;
      max-width: 68ch;
    }
    .footer-note {
      margin-top: 16px;
      color: var(--ink-soft);
      font-size: 0.8rem;
    }
    @media (max-width: 900px) {
      .shell { width: min(100vw - 16px, 1120px); margin-top: 10px; }
      .hero { padding: 16px; border-radius: 18px; }
      .detail-grid { grid-template-columns: 1fr; }
      .mini-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .hero h1 { font-size: 2rem; }
      .hero-grid { grid-template-columns: 1fr 1fr; }
      .mini-metrics { grid-template-columns: 1fr; }
      .card-grid, .run-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-top">
        <div class="hero-copy">
          <div class="eyebrow">${htmlEscape(input.kicker)}</div>
          <h1>${htmlEscape(input.heading)}</h1>
          <p>${htmlEscape(input.subheading)}</p>
        </div>
        <nav class="hero-nav" aria-label="Symphony Navigation">
          <a class="nav-pill" href="/"><strong>Overview</strong> Portfolio</a>
          <a class="nav-pill" href="/projects"><strong>Projects</strong> Registry</a>
          <a class="nav-pill" href="/runs"><strong>Runs</strong> Activity</a>
          <a class="nav-pill" href="/api/v1/state"><strong>API</strong> JSON state</a>
        </nav>
      </div>
      ${input.body}
    </section>
  </main>
</body>
</html>`;
}

function buildHeroMetrics(snapshot: Awaited<ReturnType<typeof loadDashboardSnapshot>>): string {
  const state = snapshot.runtimeState;
  const activeRuns = snapshot.runs.filter((run) =>
    run.status === 'planned' || run.status === 'dispatching' || run.status === 'running',
  ).length;
  return `<div class="hero-grid">
    ${renderMetricCard(
      'Configured Projects',
      `${state.registryProjectCount}`,
      `${pluralize(state.enabledProjectCount, 'enabled lane')} in the registry`,
    )}
    ${renderMetricCard(
      'Ready Queue',
      `${Object.values(state.projectReadyCounts).reduce((sum, count) => sum + count, 0)}`,
      'Eligible work waiting on dispatch policy',
    )}
    ${renderMetricCard(
      'Active Runs',
      `${activeRuns}`,
      state.daemonHealthy ? 'Daemon healthy and reconciling' : 'Daemon idle or offline',
    )}
    ${renderMetricCard(
      'Last Sync',
      formatTimestamp(state.updatedAt),
      state.daemonPid ? `Daemon PID ${state.daemonPid}` : 'Observe-only runtime snapshot',
    )}
  </div>`;
}

function renderProjectCard(
  project: SymphonyProjectRuntimeSummary,
  registryEntry: ProjectRegistryEntry | undefined,
): string {
  const backendBadges = (registryEntry?.allowedBackends || []).map((backend) =>
    renderBadge(backend, backend === registryEntry?.defaultBackend ? 'warm' : 'muted'),
  );
  return `<article class="project-card" data-project-key="${htmlEscape(project.projectKey)}">
    <div class="card-kicker">
      ${renderBadge(project.symphonyEnabled ? 'Symphony enabled' : 'Symphony disabled', project.symphonyEnabled ? 'good' : 'muted')}
      ${renderBadge(project.lastRunStatus, statusTone(project.lastRunStatus))}
    </div>
    <div>
      <h2 class="card-title"><a href="/projects/${encodeURIComponent(project.projectKey)}">${htmlEscape(project.displayName)}</a></h2>
      <p class="card-copy">${htmlEscape(project.projectKey)} · ${htmlEscape(registryEntry?.readyPolicy || 'No ready policy recorded')}</p>
    </div>
    <div class="mini-metrics">
      <div class="mini-metric">
        <div class="mini-label">Ready</div>
        <div class="mini-value">${project.readyQueueCount}</div>
      </div>
      <div class="mini-metric">
        <div class="mini-label">Active</div>
        <div class="mini-value">${project.activeRunCount}</div>
      </div>
      <div class="mini-metric">
        <div class="mini-label">Default</div>
        <div class="mini-value mono">${htmlEscape(registryEntry?.defaultBackend || 'n/a')}</div>
      </div>
    </div>
    <div class="badge-row">${backendBadges.join('') || renderBadge('No backends configured')}</div>
    <div class="link-row">
      ${registryEntry ? renderLink(registryEntry.notionRoot, 'Notion root') : ''}
      ${registryEntry ? renderLink(`https://github.com/${registryEntry.githubRepo}`, registryEntry.githubRepo) : ''}
      ${project.lastRunId ? `<a href="/runs/${encodeURIComponent(project.lastRunId)}">Last run</a>` : ''}
    </div>
  </article>`;
}

function renderRunCard(run: SymphonyRunRecord): string {
  return `<article class="run-card" data-run-id="${htmlEscape(run.runId)}" data-run-status="${htmlEscape(run.status)}">
    <div class="run-headline">
      <div>
        <div class="badge-row">
          ${renderBadge(run.status, statusTone(run.status))}
          ${renderBadge(run.backend, 'warm')}
        </div>
        <h2 class="card-title"><a href="/runs/${encodeURIComponent(run.runId)}">${htmlEscape(run.issueIdentifier)}</a></h2>
        <p class="card-copy">${htmlEscape(run.issueTitle)}</p>
      </div>
      <div class="card-copy mono">${htmlEscape(run.projectKey)}</div>
    </div>
    <div class="meta-grid">
      <div class="meta-item">
        <strong>Started</strong>
        <span>${htmlEscape(formatTimestamp(run.startedAt))}</span>
      </div>
      <div class="meta-item">
        <strong>Duration</strong>
        <span>${htmlEscape(formatRelativeDuration(run.startedAt, run.endedAt))}</span>
      </div>
      <div class="meta-item">
        <strong>Workspace</strong>
        <span class="mono">${htmlEscape(run.workspacePath)}</span>
      </div>
    </div>
    <div class="link-row">
      ${renderLink(run.linearIssueUrl, 'Linear issue')}
      ${renderLink(`https://github.com/${run.githubRepo}`, run.githubRepo)}
      <span class="mono">${htmlEscape(run.runId)}</span>
    </div>
  </article>`;
}

function renderHome(snapshot: Awaited<ReturnType<typeof loadDashboardSnapshot>>): string {
  const projects = snapshot.runtimeState.projects
    .map((project) =>
      renderProjectCard(
        project,
        snapshot.registry.projects.find((entry) => entry.projectKey === project.projectKey),
      ),
    )
    .join('');

  const runs = snapshot.runs.slice(0, 8).map(renderRunCard).join('');

  return pageLayout({
    title: 'Symphony Control Room',
    kicker: snapshot.runtimeState.daemonHealthy ? 'Daemon observed live' : 'Observe-only snapshot',
    heading: 'Symphony Control Room',
    subheading:
      'A portfolio view of configured projects, dispatch readiness, and live execution state across your custom Symphony runtime.',
    body: `
      ${buildHeroMetrics(snapshot)}
      <section class="section" id="project-portfolio" data-section="project-portfolio" aria-labelledby="project-portfolio-title">
        <div class="section-header">
          <div>
            <h2 class="section-title" id="project-portfolio-title">Project Portfolio</h2>
            <p class="section-note">Registry-backed projects with their dispatch posture, backend policy, and most recent runtime signal.</p>
          </div>
        </div>
        <div class="card-grid">
          ${projects || '<div class="empty-state">No projects found in the synced registry cache.</div>'}
        </div>
      </section>
      <section class="section" id="recent-runs" data-section="recent-runs" aria-labelledby="recent-runs-title">
        <div class="section-header">
          <div>
            <h2 class="section-title" id="recent-runs-title">Recent Run Activity</h2>
            <p class="section-note">Latest execution records persisted under <code>.nanoclaw/symphony/runs</code>.</p>
          </div>
          <a href="/runs">Open full run ledger</a>
        </div>
        <div class="run-grid">
          ${runs || '<div class="empty-state">No run records yet. Dispatch one Ready issue to populate the runtime ledger.</div>'}
        </div>
      </section>
      <p class="footer-note">Auto-refresh every 5 seconds. Linear remains the execution source of truth; this dashboard is the orchestration surface.</p>
    `,
  });
}

function renderIssueCard(issue: SymphonyLinearIssueSummary): string {
  return `<article class="issue-card" data-issue-id="${htmlEscape(issue.id)}" data-issue-identifier="${htmlEscape(issue.identifier)}">
    <div class="issue-headline">
      <div>
        <div class="badge-row">
          ${renderBadge(issue.state, 'good')}
          ${issue.priorityLabel ? renderBadge(issue.priorityLabel, issue.priority >= 2 ? 'warm' : 'muted') : ''}
        </div>
        <h2 class="card-title">${renderLink(issue.url, issue.identifier)}</h2>
        <p class="card-copy">${htmlEscape(issue.title)}</p>
      </div>
      <div class="card-copy mono">${htmlEscape(issue.projectName)}</div>
    </div>
    <div class="meta-grid">
      <div class="meta-item">
        <strong>Priority</strong>
        <span>${htmlEscape(issue.priorityLabel || `${issue.priority}`)}</span>
      </div>
      <div class="meta-item">
        <strong>Labels</strong>
        <span>${htmlEscape(issue.labels.join(', ') || 'No labels')}</span>
      </div>
    </div>
  </article>`;
}

function renderProjectDetail(input: {
  snapshot: Awaited<ReturnType<typeof loadDashboardSnapshot>>;
  project: ProjectRegistryEntry;
  readyIssues: SymphonyLinearIssueSummary[];
}): string {
  const recentRuns = input.snapshot.runs
    .filter((run) => run.projectKey === input.project.projectKey)
    .slice(0, 8)
    .map(renderRunCard)
    .join('');
  const runtime = input.snapshot.runtimeState.projects.find(
    (entry) => entry.projectKey === input.project.projectKey,
  );
  const readyIssues = input.readyIssues.map(renderIssueCard).join('');

  return pageLayout({
    title: `${input.project.displayName} · Symphony`,
    kicker: input.project.symphonyEnabled ? 'Project queue enabled' : 'Project queue disabled',
    heading: input.project.displayName,
    subheading:
      'Project detail across registry policy, live ready work, and run history. Use this page to validate issue shape before dispatch.',
    body: `
      ${buildHeroMetrics(input.snapshot)}
      <div class="detail-grid">
        <div class="stack">
          <section class="panel" id="ready-queue" data-section="ready-queue" aria-labelledby="ready-queue-title">
            <div class="section-header">
              <div>
                <h2 class="section-title" id="ready-queue-title">Ready Queue</h2>
                <p class="section-note">Linear issues currently visible to Symphony for this project.</p>
              </div>
            </div>
            <div class="run-grid">
              ${readyIssues || '<div class="empty-state">No Ready Symphony candidates are currently visible for this project.</div>'}
            </div>
          </section>
          <section class="panel" id="project-runs" data-section="project-runs" aria-labelledby="project-runs-title">
            <div class="section-header">
              <div>
                <h2 class="section-title" id="project-runs-title">Recent Runs</h2>
                <p class="section-note">Latest executions routed through the local runtime ledger.</p>
              </div>
            </div>
            <div class="run-grid">
              ${recentRuns || '<div class="empty-state">No run history yet for this project.</div>'}
            </div>
          </section>
        </div>
        <div class="stack">
          <section class="panel" id="project-policy" data-section="project-policy" aria-labelledby="project-policy-title">
            <div class="section-header">
              <div>
                <h2 class="section-title" id="project-policy-title">Project Policy</h2>
                <p class="section-note">Registry-backed configuration and enablement state.</p>
              </div>
            </div>
            <div class="meta-grid">
              <div class="meta-item">
                <strong>Project Key</strong>
                <span class="mono">${htmlEscape(input.project.projectKey)}</span>
              </div>
              <div class="meta-item">
                <strong>Linear Project</strong>
                <span>${htmlEscape(input.project.linearProject)}</span>
              </div>
              <div class="meta-item">
                <strong>Symphony</strong>
                <span>${input.project.symphonyEnabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div class="meta-item">
                <strong>Default Backend</strong>
                <span class="mono">${htmlEscape(input.project.defaultBackend)}</span>
              </div>
              <div class="meta-item">
                <strong>Allowed Backends</strong>
                <span>${htmlEscape(input.project.allowedBackends.join(', '))}</span>
              </div>
              <div class="meta-item">
                <strong>Ready Policy</strong>
                <span>${htmlEscape(input.project.readyPolicy)}</span>
              </div>
              <div class="meta-item">
                <strong>Workspace Root</strong>
                <span class="mono">${htmlEscape(input.project.workspaceRoot)}</span>
              </div>
              <div class="meta-item">
                <strong>Secret Scope</strong>
                <span class="mono">${htmlEscape(input.project.secretScope)}</span>
              </div>
            </div>
            <div class="link-row">
              ${renderLink(input.project.notionRoot, 'Open Notion root')}
              ${renderLink(`https://github.com/${input.project.githubRepo}`, input.project.githubRepo)}
              ${runtime?.lastRunId ? `<a href="/runs/${encodeURIComponent(runtime.lastRunId)}">Open last run</a>` : ''}
            </div>
          </section>
        </div>
      </div>
    `,
  });
}

function renderRunsPage(snapshot: Awaited<ReturnType<typeof loadDashboardSnapshot>>): string {
  const runs = snapshot.runs.map(renderRunCard).join('');
  return pageLayout({
    title: 'Symphony Run Ledger',
    kicker: 'Execution ledger',
    heading: 'Run Ledger',
    subheading:
      'A compact view of all persisted run records, intended for operator review rather than tracker truth.',
    body: `
      ${buildHeroMetrics(snapshot)}
      <section class="section" id="run-ledger" data-section="run-ledger" aria-labelledby="run-ledger-title">
        <div class="section-header">
          <div>
            <h2 class="section-title" id="run-ledger-title">All Recorded Runs</h2>
            <p class="section-note">Most recent first, with links back to the per-run detail pages.</p>
          </div>
        </div>
        <div class="run-grid">
          ${runs || '<div class="empty-state">No run records have been written yet.</div>'}
        </div>
      </section>
    `,
  });
}

function renderRunDetail(run: SymphonyRunRecord): string {
  const logTail = readLogTail(run.logFile);
  return pageLayout({
    title: `${run.issueIdentifier} · ${run.runId}`,
    kicker: `Run ${run.runId}`,
    heading: run.issueIdentifier,
    subheading:
      'Detailed view of one run record, including workspace, output paths, and the latest local log tail.',
    body: `
      <div class="hero-grid">
        ${renderMetricCard('Status', run.status, run.backend)}
        ${renderMetricCard('Duration', formatRelativeDuration(run.startedAt, run.endedAt), formatTimestamp(run.startedAt))}
        ${renderMetricCard('Project', run.projectKey, run.githubRepo)}
        ${renderMetricCard('PID', run.pid === null ? 'Not running' : `${run.pid}`, run.endedAt ? formatTimestamp(run.endedAt) : 'Process still active or not yet reconciled')}
      </div>
      <div class="detail-grid">
        <div class="stack">
          <section class="panel" id="run-metadata" data-section="run-metadata" aria-labelledby="run-metadata-title">
            <div class="section-header">
              <div>
                <h2 class="section-title" id="run-metadata-title">Run Metadata</h2>
                <p class="section-note">Persisted orchestration details for this execution.</p>
              </div>
            </div>
            <div class="meta-grid">
              <div class="meta-item">
                <strong>Linear Issue</strong>
                <span>${renderLink(run.linearIssueUrl, run.issueIdentifier)}</span>
              </div>
              <div class="meta-item">
                <strong>Workspace</strong>
                <span class="mono">${htmlEscape(run.workspacePath)}</span>
              </div>
              <div class="meta-item">
                <strong>Prompt File</strong>
                <span class="mono">${htmlEscape(run.promptFile)}</span>
              </div>
              <div class="meta-item">
                <strong>Manifest File</strong>
                <span class="mono">${htmlEscape(run.manifestFile)}</span>
              </div>
              <div class="meta-item">
                <strong>Log File</strong>
                <span class="mono">${htmlEscape(run.logFile)}</span>
              </div>
              <div class="meta-item">
                <strong>Exit File</strong>
                <span class="mono">${htmlEscape(run.exitFile)}</span>
              </div>
            </div>
            ${
              run.error
                ? `<div class="empty-state">Run error: ${htmlEscape(run.error)}</div>`
                : run.resultSummary
                  ? `<div class="empty-state">Result summary: ${htmlEscape(run.resultSummary)}</div>`
                  : ''
            }
          </section>
        </div>
        <div class="stack">
          <section class="panel log-panel" id="run-log" data-section="run-log" aria-labelledby="run-log-title">
            <div class="section-header">
              <div>
                <h2 class="section-title" id="run-log-title">Latest Log Tail</h2>
                <p class="section-note">Last local output captured for this run.</p>
              </div>
            </div>
            <pre class="log-tail">${htmlEscape(logTail)}</pre>
          </section>
        </div>
      </div>
    `,
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  registryPath: string,
): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const snapshot = await loadDashboardSnapshot(registryPath);

  if (url.pathname === '/api/v1/state') {
    sendJson(res, 200, snapshot.runtimeState);
    return true;
  }

  if (url.pathname === '/api/v1/projects') {
    sendJson(
      res,
      200,
      snapshot.registry.projects.map((project) => ({
        ...project,
        runtime:
          snapshot.runtimeState.projects.find((entry) => entry.projectKey === project.projectKey) ||
          null,
      })),
    );
    return true;
  }

  const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectKey = decodeURIComponent(projectMatch[1] || '');
    const project = snapshot.registry.projects.find((entry) => entry.projectKey === projectKey);
    if (!project) {
      sendJson(res, 404, { error: `Unknown project: ${projectKey}` });
      return true;
    }
    const readyIssues = await listReadyIssuesForProject(project);
    sendJson(res, 200, {
      ...project,
      runtime:
        snapshot.runtimeState.projects.find((entry) => entry.projectKey === project.projectKey) ||
        null,
      readyIssues,
      runs: snapshot.runs.filter((run) => run.projectKey === projectKey),
    });
    return true;
  }

  if (url.pathname === '/api/v1/runs') {
    sendJson(res, 200, snapshot.runs);
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] || '');
    try {
      sendJson(res, 200, readRunRecord(runId));
    } catch {
      sendJson(res, 404, { error: `Unknown run: ${runId}` });
    }
    return true;
  }

  return false;
}

async function handleHtml(
  req: IncomingMessage,
  res: ServerResponse,
  registryPath: string,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const snapshot = await loadDashboardSnapshot(registryPath);

  if (url.pathname === '/' || url.pathname === '/projects') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHome(snapshot));
    return;
  }

  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectKey = decodeURIComponent(projectMatch[1] || '');
    const project = snapshot.registry.projects.find((entry) => entry.projectKey === projectKey);
    if (!project) {
      res.statusCode = 404;
      res.end('Unknown project');
      return;
    }
    const readyIssues = await listReadyIssuesForProject(project);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderProjectDetail({ snapshot, project, readyIssues }));
    return;
  }

  if (url.pathname === '/runs') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderRunsPage(snapshot));
    return;
  }

  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] || '');
    try {
      const run = readRunRecord(runId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(renderRunDetail(run));
      return;
    } catch {
      res.statusCode = 404;
      res.end('Unknown run');
      return;
    }
  }

  res.statusCode = 404;
  res.end('Not found');
}

export function startSymphonyServer(input: {
  port: number;
  registryPath: string;
}): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res, input.registryPath)) {
        return;
      }
      await handleHtml(req, res, input.registryPath);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(input.port, '127.0.0.1', () => resolve(server));
  });
}
