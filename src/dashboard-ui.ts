export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Command Deck</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d0c;
      --bg-2: #12100d;
      --panel: rgba(20, 24, 22, 0.94);
      --panel-strong: rgba(25, 29, 27, 0.98);
      --panel-soft: rgba(36, 42, 38, 0.72);
      --line: rgba(136, 155, 143, 0.22);
      --line-strong: rgba(201, 149, 66, 0.42);
      --ink: #eff5ec;
      --muted: #9aa79d;
      --quiet: #6f7a73;
      --cyan: #4ad9c6;
      --brass: #c99542;
      --copper: #b75f42;
      --green: #69c783;
      --red: #e05b51;
      --shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-width: 320px;
      color: var(--ink);
      background:
        linear-gradient(180deg, rgba(74, 217, 198, 0.04), transparent 260px),
        repeating-linear-gradient(90deg, rgba(255,255,255,0.035) 0, rgba(255,255,255,0.035) 1px, transparent 1px, transparent 48px),
        repeating-linear-gradient(0deg, rgba(255,255,255,0.026) 0, rgba(255,255,255,0.026) 1px, transparent 1px, transparent 48px),
        linear-gradient(135deg, var(--bg), var(--bg-2));
    }

    button, input {
      font: inherit;
    }

    button {
      color: inherit;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 18px 26px;
      border-bottom: 1px solid var(--line);
      background: rgba(10, 13, 12, 0.88);
      backdrop-filter: blur(16px);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .mark {
      width: 42px;
      height: 42px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: var(--brass);
      font-family: var(--mono);
      font-weight: 800;
      background:
        linear-gradient(135deg, rgba(201,149,66,0.14), transparent),
        rgba(255,255,255,0.025);
      box-shadow: inset 0 0 24px rgba(74, 217, 198, 0.08);
      flex: 0 0 auto;
    }

    .brand-copy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.05;
      letter-spacing: 0;
    }

    #subtitle {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .search {
      width: min(360px, 34vw);
      min-width: 220px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.055);
      color: var(--ink);
      padding: 10px 12px;
      outline: none;
    }

    .search::placeholder {
      color: var(--quiet);
    }

    .search:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px rgba(74, 217, 198, 0.12);
    }

    .refresh {
      border: 1px solid rgba(201,149,66,0.45);
      background: rgba(201,149,66,0.14);
      color: var(--brass);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .shell {
      width: min(1560px, 100%);
      margin: 0 auto;
      padding: 20px 26px 44px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
      padding: 14px;
      min-height: 78px;
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
    }

    .metric::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--brass);
      opacity: 0.74;
    }

    .metric b {
      display: block;
      font-family: var(--mono);
      font-size: 24px;
      line-height: 1;
      margin-bottom: 8px;
      letter-spacing: 0;
    }

    .metric span {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .view-tabs {
      display: flex;
      gap: 8px;
      align-items: center;
      overflow-x: auto;
      padding: 2px 0 14px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }

    .view-tab {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.035);
      color: var(--muted);
      border-radius: 8px;
      padding: 9px 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .view-tab.active {
      color: var(--ink);
      border-color: rgba(74,217,198,0.52);
      background: rgba(74,217,198,0.1);
      box-shadow: inset 0 -2px 0 rgba(74,217,198,0.72);
    }

    .deck {
      display: grid;
      grid-template-columns: minmax(220px, 270px) minmax(0, 1fr) minmax(310px, 380px);
      gap: 16px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .panel-pad {
      padding: 16px;
    }

    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    h2, h3 {
      margin: 0;
      letter-spacing: 0;
      line-height: 1.16;
    }

    h2 { font-size: 17px; }
    h3 { font-size: 13px; }

    .eyebrow {
      color: var(--brass);
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .muted { color: var(--muted); }
    .small { font-size: 12px; }

    .agent-rail {
      position: sticky;
      top: 94px;
      overflow: hidden;
    }

    .agent-rail-head {
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--line);
    }

    .agent-tabs {
      display: grid;
      gap: 6px;
      padding: 8px;
      max-height: calc(100vh - 220px);
      overflow: auto;
    }

    .agent-tab {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      width: 100%;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      padding: 10px;
      cursor: pointer;
      text-align: left;
      min-width: 0;
    }

    .agent-tab:hover {
      background: rgba(255,255,255,0.045);
      color: var(--ink);
    }

    .agent-tab.active {
      border-color: rgba(74,217,198,0.5);
      background: linear-gradient(90deg, rgba(74,217,198,0.13), rgba(201,149,66,0.055));
      color: var(--ink);
    }

    .node {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--quiet);
      box-shadow: 0 0 0 3px rgba(255,255,255,0.035);
    }

    .node.live {
      background: var(--green);
      box-shadow: 0 0 0 3px rgba(105,199,131,0.14), 0 0 16px rgba(105,199,131,0.5);
    }

    .agent-tab b {
      display: block;
      font-size: 13px;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-tab small {
      display: block;
      color: var(--quiet);
      font-size: 11px;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .count-chip {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--brass);
      border: 1px solid rgba(201,149,66,0.36);
      border-radius: 999px;
      padding: 3px 6px;
      background: rgba(201,149,66,0.08);
    }

    .agent-focus {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    .hero-panel {
      border-color: rgba(74,217,198,0.28);
      background:
        linear-gradient(135deg, rgba(74,217,198,0.11), rgba(201,149,66,0.07)),
        var(--panel-strong);
      overflow: hidden;
    }

    .hero-inner {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      padding: 18px;
    }

    .hero-title {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    .hero-title h2 {
      font-size: 28px;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    .hero-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 6px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 8px;
      color: var(--muted);
      background: rgba(255,255,255,0.035);
      font-size: 12px;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }

    .chip.cyan {
      color: var(--cyan);
      border-color: rgba(74,217,198,0.35);
      background: rgba(74,217,198,0.08);
    }

    .chip.brass {
      color: var(--brass);
      border-color: rgba(201,149,66,0.38);
      background: rgba(201,149,66,0.08);
    }

    .hero-stats {
      display: grid;
      grid-template-columns: repeat(3, 92px);
      gap: 8px;
      align-content: start;
    }

    .mini-stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: rgba(0,0,0,0.18);
      min-height: 68px;
    }

    .mini-stat b {
      display: block;
      font-family: var(--mono);
      font-size: 20px;
      line-height: 1;
      margin-bottom: 7px;
    }

    .mini-stat span {
      color: var(--quiet);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .focus-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 0.72fr);
      gap: 14px;
    }

    .stack {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    .list {
      display: grid;
      gap: 9px;
      padding: 0;
      margin: 10px 0 0;
      list-style: none;
    }

    .list li {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      color: var(--ink);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .list li::before {
      content: "";
      width: 7px;
      height: 7px;
      margin-top: 6px;
      border-radius: 2px;
      background: var(--brass);
      box-shadow: 0 0 12px rgba(201,149,66,0.42);
    }

    .skill-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }

    .skill-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      padding: 11px;
      cursor: pointer;
      text-align: left;
      min-width: 0;
    }

    .skill-row:hover {
      border-color: rgba(74,217,198,0.42);
      background: rgba(74,217,198,0.06);
    }

    .skill-row.active {
      border-color: rgba(201,149,66,0.55);
      background: rgba(201,149,66,0.09);
    }

    .skill-row b {
      display: block;
      font-size: 13px;
      margin-bottom: 4px;
      overflow-wrap: anywhere;
    }

    .skill-row span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .arrow {
      color: var(--brass);
      font-family: var(--mono);
      font-size: 16px;
    }

    .context-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }

    .context-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: rgba(255,255,255,0.028);
      min-width: 0;
    }

    .context-item b {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
      overflow-wrap: anywhere;
    }

    .context-item span {
      display: block;
      color: var(--quiet);
      font-size: 11px;
      overflow-wrap: anywhere;
    }

    .inspector {
      position: sticky;
      top: 94px;
      overflow: hidden;
    }

    .inspector .panel-pad {
      display: grid;
      gap: 14px;
    }

    .description {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      margin: 0;
      overflow-wrap: anywhere;
    }

    .command {
      display: block;
      background: #050706;
      border: 1px solid rgba(74,217,198,0.2);
      color: #d8fff7;
      border-radius: 8px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
      overflow-x: auto;
      white-space: pre;
      margin-top: 8px;
    }

    .atlas {
      display: grid;
      gap: 10px;
    }

    .atlas-group + .atlas-group {
      margin-top: 18px;
    }

    .atlas-group-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 4px 2px 8px;
    }

    .atlas-row {
      display: grid;
      grid-template-columns: minmax(170px, 0.32fr) minmax(0, 1fr) minmax(170px, 0.26fr);
      gap: 12px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
      box-shadow: var(--shadow);
    }

    .atlas-row h2 {
      font-size: 15px;
      margin-bottom: 5px;
      overflow-wrap: anywhere;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
    }

    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    th {
      color: var(--brass);
      background: rgba(201,149,66,0.08);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .activity-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(310px, 0.35fr);
      gap: 14px;
      align-items: start;
    }

    .bars {
      display: grid;
      gap: 8px;
    }

    .bar-row {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr) 56px;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }

    .bar-track {
      height: 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.055);
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--cyan), var(--brass));
      min-width: 2px;
    }

    .terminal {
      background: #050706;
      color: #d8fff7;
      border: 1px solid rgba(74,217,198,0.18);
      border-radius: 8px;
      padding: 14px;
      min-height: 420px;
      max-height: 72vh;
      overflow: auto;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      box-shadow: var(--shadow);
    }

    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.025);
      color: var(--muted);
      padding: 22px;
      text-align: center;
    }

    .raw {
      background: #050706;
      color: #d8fff7;
      border: 1px solid rgba(74,217,198,0.18);
      border-radius: 8px;
      padding: 14px;
      overflow: auto;
      max-height: 72vh;
      font-size: 12px;
      line-height: 1.45;
    }

    @media (max-width: 1260px) {
      .deck {
        grid-template-columns: 230px minmax(0, 1fr);
      }

      .inspector {
        grid-column: 1 / -1;
        position: static;
      }

      .metrics {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }

    @media (max-width: 920px) {
      .topbar {
        grid-template-columns: 1fr;
        padding: 14px;
      }

      .top-actions {
        width: 100%;
      }

      .search {
        width: 100%;
        min-width: 0;
      }

      .shell {
        padding: 14px;
      }

      .deck,
      .focus-grid,
      .activity-grid,
      .hero-inner {
        grid-template-columns: 1fr;
      }

      .agent-rail {
        position: static;
      }

      .agent-tabs {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        max-height: none;
      }

      .hero-stats {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .atlas-row {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .agent-tabs {
        grid-template-columns: 1fr;
      }

      .context-grid {
        grid-template-columns: 1fr;
      }

      .hero-title h2 {
        font-size: 22px;
      }

      .bar-row {
        grid-template-columns: 82px minmax(0, 1fr) 42px;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="mark">NC</div>
      <div class="brand-copy">
        <h1>NanoClaw Command Deck</h1>
        <span id="subtitle">Waiting for runtime snapshot</span>
      </div>
    </div>
    <div class="top-actions">
      <input id="search" class="search" placeholder="Search agents, skills, commands" autocomplete="off">
      <button id="refresh" class="refresh" type="button">Refresh</button>
    </div>
  </header>

  <main class="shell">
    <section id="metrics" class="metrics"></section>
    <nav class="view-tabs" aria-label="Dashboard views">
      <button class="view-tab active" data-view="agents" type="button">Agents</button>
      <button class="view-tab" data-view="catalog" type="button">Skill Atlas</button>
      <button class="view-tab" data-view="activity" type="button">Activity</button>
      <button class="view-tab" data-view="logs" type="button">Logs</button>
      <button class="view-tab" data-view="raw" type="button">Raw</button>
    </nav>
    <section id="content"></section>
  </main>

  <script>
    var state = { snapshot: null, logs: [], serverTime: null };
    var activeView = 'agents';
    var selectedAgentId = null;
    var selectedSkillId = null;
    var searchTerm = '';

    var content = document.getElementById('content');
    var metrics = document.getElementById('metrics');
    var subtitle = document.getElementById('subtitle');
    var searchInput = document.getElementById('search');

    document.getElementById('refresh').addEventListener('click', refresh);
    searchInput.addEventListener('input', function (event) {
      searchTerm = event.target.value.trim().toLowerCase();
      render();
    });

    document.addEventListener('click', function (event) {
      var viewButton = event.target.closest('[data-view]');
      if (viewButton) {
        activeView = viewButton.getAttribute('data-view');
        document.querySelectorAll('.view-tab').forEach(function (button) {
          button.classList.toggle('active', button.getAttribute('data-view') === activeView);
        });
        render();
        return;
      }

      var agentButton = event.target.closest('[data-agent]');
      if (agentButton) {
        selectedAgentId = agentButton.getAttribute('data-agent');
        selectedSkillId = null;
        render();
        return;
      }

      var skillButton = event.target.closest('[data-skill]');
      if (skillButton) {
        selectedSkillId = skillButton.getAttribute('data-skill');
        activeView = 'agents';
        document.querySelectorAll('.view-tab').forEach(function (button) {
          button.classList.toggle('active', button.getAttribute('data-view') === activeView);
        });
        render();
      }
    });

    async function refresh() {
      try {
        var response = await fetch('/api/state', { cache: 'no-store' });
        var payload = await response.json();
        state.snapshot = payload.snapshot;
        state.logs = Array.isArray(payload.logs) ? payload.logs : [];
        state.serverTime = payload.serverTime;
        render();
      } catch (error) {
        content.innerHTML = '<div class="empty">Dashboard API is not responding: ' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function render() {
      var snapshot = state.snapshot || {};
      var caps = snapshot.capabilities || {};
      var agents = asArray(caps.agents);
      var skills = asArray(caps.skills);
      var totals = caps.totals || {};

      subtitle.textContent = snapshot.timestamp
        ? 'Last snapshot ' + formatTime(snapshot.timestamp) + ' | uptime ' + formatDuration(snapshot.uptime || 0)
        : 'Waiting for runtime snapshot';

      metrics.innerHTML = [
        metric(agents.length || count(snapshot.agent_groups), 'Agents'),
        metric(totals.capabilityLinks != null ? totals.capabilityLinks : countCapabilities(agents), 'Capabilities'),
        metric(countRunning(agents), 'Running'),
        metric(totals.totalSessions != null ? totals.totalSessions : countSessions(agents), 'Sessions'),
        metric(count(snapshot.channels), 'Channels')
      ].join('');

      if (!state.snapshot) {
        content.innerHTML = '<div class="empty">No snapshot yet. Start NanoClaw with DASHBOARD_SECRET set and the pusher will fill this page.</div>';
        return;
      }

      if (activeView === 'agents') content.innerHTML = renderAgents(agents, skills);
      else if (activeView === 'catalog') content.innerHTML = renderCatalog(skills);
      else if (activeView === 'activity') content.innerHTML = renderActivity(snapshot);
      else if (activeView === 'logs') content.innerHTML = renderLogs(state.logs);
      else content.innerHTML = '<pre class="raw">' + escapeHtml(JSON.stringify(snapshot, null, 2)) + '</pre>';
    }

    function renderAgents(agents, skills) {
      var visibleAgents = filterItems(agents, agentSearchText);
      if (!visibleAgents.length && searchTerm) {
        return '<div class="empty">No agents match this search.</div>';
      }

      var agent = selectAgent(visibleAgents.length ? visibleAgents : agents);
      if (!agent) return '<div class="empty">No agents are registered yet.</div>';

      var agentSkills = asArray(agent.skills);
      var capabilitySkills = agentSkills.filter(isCapability);
      var operationalSkills = agentSkills.filter(function (skill) { return !isCapability(skill); });
      var skill = selectSkill(capabilitySkills.length ? capabilitySkills : agentSkills, skills);

      return '<div class="deck">' +
        '<aside class="panel agent-rail">' +
          '<div class="agent-rail-head"><div class="eyebrow">Agent Tabs</div><h2>Choose a desk</h2></div>' +
          '<div class="agent-tabs">' + visibleAgents.map(renderAgentTab).join('') + '</div>' +
        '</aside>' +
        '<section class="agent-focus">' +
          renderAgentHero(agent, capabilitySkills) +
          '<div class="focus-grid">' +
            '<div class="stack">' +
              renderMissionPanel(agent) +
              renderHowToPanel(agent) +
            '</div>' +
            '<div class="stack">' +
              renderCapabilitiesPanel(capabilitySkills) +
              renderContextPanel(agent, operationalSkills) +
            '</div>' +
          '</div>' +
        '</section>' +
        '<aside class="panel inspector">' + renderSkillInspector(skill, skills) + '</aside>' +
      '</div>';
    }

    function isCapability(skill) {
      return (skill && skill.kind ? skill.kind : 'capability') === 'capability';
    }

    function selectAgent(agents) {
      if (!agents.length) return null;
      var selected = agents.find(function (agent) { return String(agent.id || agent.folder) === selectedAgentId; });
      if (!selected) {
        selected = agents[0];
        selectedAgentId = String(selected.id || selected.folder || '');
      }
      return selected;
    }

    function selectSkill(agentSkills, catalogSkills) {
      var selected = agentSkills.find(function (skill) { return skill.id === selectedSkillId || skill.name === selectedSkillId; });
      if (!selected && agentSkills.length) {
        selected = agentSkills[0];
        selectedSkillId = selected.id || selected.name;
      }
      var catalogMatch = selected ? findSkill(catalogSkills, selected.id || selected.name) : null;
      return catalogMatch || selected || null;
    }

    function renderAgentTab(agent) {
      var id = String(agent.id || agent.folder || agent.name || '');
      var active = id === selectedAgentId ? ' active' : '';
      var live = toFiniteNumber(agent.runningSessions) > 0 ? ' live' : '';
      var capCount = asArray(agent.skills).filter(isCapability).length;
      return '<button class="agent-tab' + active + '" type="button" data-agent="' + escapeAttr(id) + '">' +
        '<span class="node' + live + '"></span>' +
        '<span><b>' + escapeHtml(agent.name || agent.folder || 'Agent') + '</b><small>' + escapeHtml(agent.primaryInterface || agent.botIdentity || agent.folder || '') + '</small></span>' +
        '<span class="count-chip">' + capCount + '</span>' +
      '</button>';
    }

    function renderAgentHero(agent, capabilitySkills) {
      return '<article class="panel hero-panel">' +
        '<div class="hero-inner">' +
          '<div class="hero-title">' +
            '<div class="eyebrow">Active Capability Profile</div>' +
            '<h2>' + escapeHtml(agent.name || agent.folder || 'Agent') + '</h2>' +
            '<div class="hero-meta">' +
              chip(agent.primaryInterface || agent.botIdentity || agent.folder || 'No interface listed', 'cyan') +
              chip(agent.provider || 'agent', 'brass') +
              chip(toFiniteNumber(agent.runningSessions) > 0 ? 'live container' : 'idle') +
            '</div>' +
          '</div>' +
          '<div class="hero-stats">' +
            miniStat(capabilitySkills.length, 'Capabilities') +
            miniStat(agent.sessionCount || 0, 'Sessions') +
            miniStat(agent.runningSessions || 0, 'Running') +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function renderMissionPanel(agent) {
      var purpose = asArray(agent.purpose);
      return '<article class="panel panel-pad">' +
        '<div class="panel-head"><div><div class="eyebrow">Mission</div><h2>What this agent is for</h2></div></div>' +
        (purpose.length ? renderList(purpose, 6) : '<p class="description">No purpose section found in this agent\\'s local instructions.</p>') +
      '</article>';
    }

    function renderHowToPanel(agent) {
      var asks = asArray(agent.howToAsk);
      return '<article class="panel panel-pad">' +
        '<div class="panel-head"><div><div class="eyebrow">Use It</div><h2>Good prompts</h2></div></div>' +
        (asks.length ? '<ul class="list">' + asks.slice(0, 6).map(function (item) {
          return '<li>' + escapeHtml(item.ask || item) + '</li>';
        }).join('') + '</ul>' : '<p class="description">No prompt examples available yet.</p>') +
      '</article>';
    }

    function renderCapabilitiesPanel(skills) {
      return '<article class="panel panel-pad">' +
        '<div class="panel-head"><div><div class="eyebrow">Capabilities</div><h2>What this agent does</h2></div><span class="count-chip">' + skills.length + '</span></div>' +
        (skills.length ? '<div class="skill-list">' + skills.map(renderSkillRow).join('') + '</div>' : '<p class="description">No user-facing capabilities mounted in this agent\\'s container config.</p>') +
      '</article>';
    }

    function renderSkillRow(skill) {
      var id = skill.id || skill.name || '';
      var active = id === selectedSkillId || skill.name === selectedSkillId ? ' active' : '';
      return '<button class="skill-row' + active + '" type="button" data-skill="' + escapeAttr(id) + '">' +
        '<span><b>' + escapeHtml(skill.name || skill.id || 'Skill') + '</b><span>' + escapeHtml(shorten(skill.description || '', 132)) + '</span></span>' +
        '<span class="arrow">></span>' +
      '</button>';
    }

    function renderContextPanel(agent, operationalSkills) {
      var mounts = asArray(agent.mounts);
      var packages = agent.packages || {};
      var env = asArray(agent.envPassThrough);
      var mcp = asArray(agent.mcpServers);
      var ops = asArray(operationalSkills);
      var packageLabels = Object.keys(packages).filter(function (key) { return count(packages[key]) > 0; }).map(function (key) {
        return key + ': ' + packages[key].join(', ');
      });

      var items = [];
      if (ops.length) items.push({ title: 'Operational skills', detail: ops.map(function (skill) { return skill.name || skill.id; }).join(', ') });
      if (mcp.length) items.push({ title: 'MCP servers', detail: mcp.join(', ') });
      mounts.slice(0, 6).forEach(function (mount) {
        var label = cleanMountLabel(mount.containerPath || mount.hostPath || 'mount');
        items.push({ title: label, detail: mount.readonly ? 'read-only mount' : 'writable mount' });
      });
      packageLabels.slice(0, 4).forEach(function (label) { items.push({ title: 'Packages', detail: label }); });
      if (env.length) items.push({ title: 'Env passthrough', detail: env.slice(0, 6).join(', ') + (env.length > 6 ? ' +' + (env.length - 6) : '') });

      return '<article class="panel panel-pad">' +
        '<div class="panel-head"><div><div class="eyebrow">Context</div><h2>Tools and mounts</h2></div></div>' +
        (items.length ? '<div class="context-grid">' + items.map(function (item) {
          return '<div class="context-item"><b>' + escapeHtml(item.title) + '</b><span>' + escapeHtml(item.detail) + '</span></div>';
        }).join('') + '</div>' : '<p class="description">No extra mounts, packages, env vars, or MCP servers are listed.</p>') +
      '</article>';
    }

    function renderSkillInspector(skill, catalogSkills) {
      if (!skill) return '<div class="panel-pad"><div class="empty">Select a skill to inspect it.</div></div>';
      var catalogMatch = findSkill(catalogSkills, skill.id || skill.name) || skill;
      var commands = asArray(catalogMatch.commandExamples);
      var asks = asArray(catalogMatch.howToAsk);
      var sections = asArray(catalogMatch.sections);
      var usedBy = asArray(catalogMatch.usedBy);

      return '<div class="panel-pad">' +
        '<div><div class="eyebrow">Skill Inspector</div><h2>' + escapeHtml(catalogMatch.name || catalogMatch.id || 'Skill') + '</h2></div>' +
        '<p class="description">' + escapeHtml(catalogMatch.description || 'No description found.') + '</p>' +
        (usedBy.length ? '<div class="pill-row">' + usedBy.map(function (agent) { return chip(agent.name || agent.folder || 'Agent', 'cyan'); }).join('') + '</div>' : '') +
        (asks.length ? '<div><h3>How to ask</h3><ul class="list">' + asks.slice(0, 4).map(function (ask) { return '<li>' + escapeHtml(ask) + '</li>'; }).join('') + '</ul></div>' : '') +
        (commands.length ? '<div><h3>Safe commands</h3>' + commands.slice(0, 5).map(function (command) { return '<code class="command">' + escapeHtml(command) + '</code>'; }).join('') + '</div>' : '') +
        sections.slice(0, 2).map(function (section) {
          return '<div><h3>' + escapeHtml(section.title) + '</h3>' + renderList(section.lines || [], 5) + '</div>';
        }).join('') +
      '</div>';
    }

    function renderCatalog(skills) {
      var visibleSkills = filterItems(skills, function (skill) {
        return [skill.name, skill.description, skill.path, asArray(skill.usedBy).map(function (agent) { return agent.name || agent.folder; }).join(' ')].join(' ');
      });
      if (!visibleSkills.length) return '<div class="empty">No skills match this search.</div>';

      var capabilities = visibleSkills.filter(isCapability);
      var operational = visibleSkills.filter(function (skill) { return !isCapability(skill); });

      function renderRow(skill) {
        var usedBy = asArray(skill.usedBy);
        var badge = skill.kind === 'operational' ? chip('operational', 'brass') : '';
        return '<article class="atlas-row">' +
          '<div><div class="eyebrow">' + (skill.kind === 'operational' ? 'Operational' : 'Capability') + '</div><h2>' + escapeHtml(skill.name || skill.id || 'Skill') + '</h2><span class="muted small">' + escapeHtml(skill.path || '') + '</span></div>' +
          '<p class="description">' + escapeHtml(skill.description || '') + '</p>' +
          '<div class="pill-row">' + (usedBy.length ? usedBy.map(function (agent) { return chip(agent.name || agent.folder, 'cyan'); }).join('') : chip('not mounted')) + badge + '</div>' +
        '</article>';
      }

      function renderGroup(title, count, rows) {
        if (!rows.length) return '';
        return '<div class="atlas-group">' +
          '<div class="atlas-group-head"><div class="eyebrow">' + escapeHtml(title) + '</div><span class="count-chip">' + count + '</span></div>' +
          '<div class="atlas">' + rows.map(renderRow).join('') + '</div>' +
        '</div>';
      }

      return renderGroup('Capabilities', capabilities.length, capabilities) +
        renderGroup('Operational', operational.length, operational);
    }

    function renderActivity(snapshot) {
      var sessions = asArray(snapshot.sessions);
      var activity = asArray(snapshot.activity);
      var totals = (snapshot.tokens || {}).totals || {};
      return '<div class="activity-grid">' +
        '<div class="stack">' +
          '<article class="panel panel-pad"><div class="panel-head"><div><div class="eyebrow">Traffic</div><h2>Message activity</h2></div><span class="muted small">Last 24 hours</span></div>' +
          renderBars(activity) + '</article>' +
          renderSessionsTable(sessions) +
        '</div>' +
        '<aside class="panel panel-pad">' +
          '<div class="eyebrow">Token Meter</div><h2>Usage snapshot</h2>' +
          renderList([
            'Requests: ' + formatNumber(totals.requests || 0),
            'Input tokens: ' + formatNumber(totals.inputTokens || 0),
            'Output tokens: ' + formatNumber(totals.outputTokens || 0),
            'Cache read: ' + formatNumber(totals.cacheReadTokens || 0)
          ], 6) +
        '</aside>' +
      '</div>';
    }

    function renderSessionsTable(sessions) {
      if (!sessions.length) return '<div class="empty">No session rows yet.</div>';
      return '<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Status</th><th>Channel</th><th>Last active</th></tr></thead><tbody>' +
        sessions.slice(0, 80).map(function (session) {
          return '<tr>' +
            '<td>' + escapeHtml(session.agent_group_name || session.agent_group_folder || session.agent_group_id || '') + '</td>' +
            '<td>' + escapeHtml(session.container_status || session.status || '') + '</td>' +
            '<td>' + escapeHtml(session.channel_type || '') + '</td>' +
            '<td>' + escapeHtml(session.last_active || session.updated_at || '') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    function renderBars(activity) {
      if (!activity.length) return '<div class="empty">No activity buckets yet.</div>';
      var max = activity.reduce(function (value, row) {
        return Math.max(value, toFiniteNumber(row.inbound) + toFiniteNumber(row.outbound));
      }, 1);
      return '<div class="bars">' + activity.map(function (row) {
        var total = toFiniteNumber(row.inbound) + toFiniteNumber(row.outbound);
        var width = Math.max(2, Math.round((total / max) * 100));
        return '<div class="bar-row"><span>' + escapeHtml(formatHour(row.hour)) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><b>' + escapeHtml(String(total)) + '</b></div>';
      }).join('') + '</div>';
    }

    function renderLogs(logs) {
      if (!logs.length) return '<div class="empty">No logs have been pushed yet.</div>';
      return '<pre class="terminal">' + escapeHtml(logs.slice(-500).join('\\n')) + '</pre>';
    }

    function renderList(items, limit) {
      var lines = asArray(items).slice(0, limit);
      if (!lines.length) return '';
      return '<ul class="list">' + lines.map(function (item) {
        return '<li>' + escapeHtml(item) + '</li>';
      }).join('') + '</ul>';
    }

    function metric(value, label) {
      return '<div class="metric"><b>' + escapeHtml(formatNumber(value)) + '</b><span>' + escapeHtml(label) + '</span></div>';
    }

    function miniStat(value, label) {
      return '<div class="mini-stat"><b>' + escapeHtml(formatNumber(value)) + '</b><span>' + escapeHtml(label) + '</span></div>';
    }

    function chip(label, tone) {
      return '<span class="chip ' + escapeAttr(tone || '') + '">' + escapeHtml(label) + '</span>';
    }

    function filterItems(items, textFn) {
      if (!searchTerm) return asArray(items);
      return asArray(items).filter(function (item) {
        return textFn(item).toLowerCase().indexOf(searchTerm) !== -1;
      });
    }

    function agentSearchText(agent) {
      return [
        agent.name,
        agent.folder,
        agent.primaryInterface,
        asArray(agent.purpose).join(' '),
        asArray(agent.skills).map(function (skill) { return (skill.name || '') + ' ' + (skill.description || ''); }).join(' ')
      ].join(' ');
    }

    function findSkill(skills, id) {
      if (!id) return null;
      return asArray(skills).find(function (skill) { return skill.id === id || skill.name === id; }) || null;
    }

    function cleanMountLabel(value) {
      return String(value || '').replace(/^\\/+/, '') || 'mount';
    }

    function count(value) {
      return Array.isArray(value) ? value.length : 0;
    }

    function countRunning(agents) {
      return asArray(agents).reduce(function (sum, agent) { return sum + toFiniteNumber(agent.runningSessions); }, 0);
    }

    function countCapabilities(agents) {
      return asArray(agents).reduce(function (sum, agent) {
        return sum + asArray(agent.skills).filter(isCapability).length;
      }, 0);
    }

    function countSessions(agents) {
      return asArray(agents).reduce(function (sum, agent) { return sum + toFiniteNumber(agent.sessionCount); }, 0);
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function formatNumber(value) {
      return toFiniteNumber(value).toLocaleString();
    }

    function formatDuration(seconds) {
      var safeSeconds = toFiniteNumber(seconds);
      var hours = Math.floor(safeSeconds / 3600);
      var minutes = Math.floor((safeSeconds % 3600) / 60);
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      return minutes + 'm';
    }

    function toFiniteNumber(value) {
      var number = Number(value || 0);
      return Number.isFinite(number) ? number : 0;
    }

    function formatTime(value) {
      if (!value) return '';
      try {
        return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch {
        return value;
      }
    }

    function formatHour(value) {
      if (!value) return '';
      try {
        return new Date(value + ':00:00Z').toLocaleString([], { hour: '2-digit', month: 'short', day: 'numeric' });
      } catch {
        return value;
      }
    }

    function shorten(value, max) {
      var text = String(value || '');
      return text.length > max ? text.slice(0, max - 1) + '...' : text;
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
