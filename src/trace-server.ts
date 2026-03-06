/**
 * NanoClaw Trace UI — lightweight Express server for agent observability
 * Shows tool calls, LLM call durations, and token usage per agent run.
 */
import express from 'express';
import {
  getTraces,
  getTrace,
  getLlmCalls,
  getToolCalls,
  getStats,
} from './trace-db.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.TRACE_PORT || '3001', 10);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuKI Trace UI</title>
<style>
  :root { --bg:#0f1117; --card:#1a1d27; --border:#2a2d3e; --accent:#6c7ae0; --green:#4caf50; --red:#f44336; --yellow:#ff9800; --text:#e0e0e0; --muted:#888; }
  * { box-sizing:border-box; margin:0; padding:0 }
  body { background:var(--bg); color:var(--text); font:14px/1.5 "SF Mono",monospace; padding:20px }
  h1 { color:var(--accent); margin-bottom:4px; font-size:20px }
  .subtitle { color:var(--muted); margin-bottom:20px; font-size:12px }
  .stats { display:flex; gap:16px; margin-bottom:20px; flex-wrap:wrap }
  .stat { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 20px; text-align:center }
  .stat .val { font-size:24px; font-weight:bold; color:var(--accent) }
  .stat .lbl { font-size:11px; color:var(--muted); margin-top:2px }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:8px; overflow:hidden; margin-bottom:20px }
  th { background:#222535; color:var(--muted); font-size:11px; text-transform:uppercase; padding:10px 12px; text-align:left; border-bottom:1px solid var(--border) }
  td { padding:9px 12px; border-bottom:1px solid var(--border); font-size:12px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  tr:hover td { background:#1f2235; cursor:pointer }
  .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold }
  .badge.success { background:#1a3a1a; color:var(--green) }
  .badge.error { background:#3a1a1a; color:var(--red) }
  .badge.running { background:#3a2a0a; color:var(--yellow) }
  .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:100; overflow:auto; padding:20px }
  .modal.open { display:flex; align-items:flex-start; justify-content:center }
  .modal-box { background:var(--card); border:1px solid var(--border); border-radius:10px; width:100%; max-width:900px; padding:24px; position:relative; margin-top:40px }
  .modal-close { position:absolute; top:12px; right:16px; background:none; border:none; color:var(--muted); font-size:20px; cursor:pointer }
  .timeline { position:relative; padding-left:24px; margin-top:16px }
  .timeline::before { content:''; position:absolute; left:8px; top:0; bottom:0; width:2px; background:var(--border) }
  .tl-item { position:relative; margin-bottom:12px }
  .tl-dot { position:absolute; left:-20px; top:4px; width:10px; height:10px; border-radius:50%; border:2px solid }
  .tl-dot.llm { border-color:var(--accent); background:#1a1d27 }
  .tl-dot.tool { border-color:var(--green); background:#1a1d27 }
  .tl-dot.info { border-color:var(--muted); background:#1a1d27 }
  .tl-content { background:#12151f; border:1px solid var(--border); border-radius:6px; padding:8px 12px; font-size:12px }
  .tl-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px }
  .tl-name { font-weight:bold; color:var(--accent) }
  .tl-name.tool { color:var(--green) }
  .tl-dur { color:var(--muted); font-size:11px }
  .tl-detail { color:var(--muted); font-size:11px; white-space:pre-wrap; word-break:break-word; margin-top:4px }
  .tokens { font-size:11px; color:var(--muted) }
  .tokens span { color:var(--text) }
  .refresh-btn { background:var(--accent); border:none; color:#fff; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px; margin-left:12px }
  .search { background:var(--card); border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:6px; font-size:12px; width:220px }
  .toolbar { display:flex; align-items:center; gap:8px; margin-bottom:12px }
  .auto-badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:10px; background:#2a1a3a; color:#b088f0 }
</style>
</head>
<body>
<h1>⚡ SuKI Trace UI</h1>
<p class="subtitle">Agent runs · LLM calls · Tool usage · 90-day retention</p>
<div id="stats"></div>
<div class="toolbar">
  <input class="search" id="search" placeholder="Filter by group or prompt…" oninput="filterRows()">
  <button class="refresh-btn" onclick="loadAll()">↺ Refresh</button>
  <span id="last-refresh" style="font-size:11px;color:var(--muted)"></span>
</div>
<table id="traces-table">
  <thead><tr>
    <th>Started</th><th>Group</th><th>Status</th><th>Duration</th>
    <th>LLM calls</th><th>Tokens in/out</th><th>Tool calls</th><th>Prompt preview</th>
  </tr></thead>
  <tbody id="traces-body"></tbody>
</table>

<div class="modal" id="modal">
  <div class="modal-box">
    <button class="modal-close" onclick="closeModal()">×</button>
    <div id="modal-content"></div>
  </div>
</div>

<script>
let allRows = [];

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function dur(start, end) {
  if (!start) return '—';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return (ms/60000).toFixed(1) + 'min';
}
function badge(status) {
  const cls = status === 'success' ? 'success' : status === 'error' ? 'error' : 'running';
  const label = status || 'running';
  return '<span class="badge ' + cls + '">' + label + '</span>';
}

async function loadStats() {
  const r = await fetch('/api/stats');
  const s = await r.json();
  document.getElementById('stats').innerHTML =
    stat(s.total_traces, 'Traces (7d)') +
    stat(s.error_traces, 'Errors (7d)') +
    stat((s.total_input_tokens||0).toLocaleString(), 'Tokens in (7d)') +
    stat((s.total_output_tokens||0).toLocaleString(), 'Tokens out (7d)') +
    stat(s.total_tool_calls, 'Tool calls (7d)') +
    '</div>';
  document.getElementById('stats').outerHTML = '<div class="stats">' + document.getElementById('stats').innerHTML;
}
function stat(v, l) {
  return '<div class="stat"><div class="val">'+(v??0)+'</div><div class="lbl">'+l+'</div></div>';
}

async function loadAll() {
  const r = await fetch('/api/traces');
  allRows = await r.json();
  renderRows(allRows);
  document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString('de-DE');
}

function renderRows(rows) {
  const tb = document.getElementById('traces-body');
  tb.innerHTML = rows.map(t => {
    const auto = t.is_scheduled ? '<span class="auto-badge">sched</span> ' : '';
    return '<tr onclick="openTrace(\\''+t.id+'\\')">' +
      '<td>'+fmt(t.started_at)+'</td>' +
      '<td>'+t.group_folder+'</td>' +
      '<td>'+badge(t.status)+'</td>' +
      '<td>'+dur(t.started_at, t.finished_at)+'</td>' +
      '<td style="text-align:center">'+( t.llm_calls||0)+'</td>' +
      '<td class="tokens"><span>'+(t.total_input_tokens||0)+'</span> / <span>'+(t.total_output_tokens||0)+'</span></td>' +
      '<td style="text-align:center">'+(t.tool_calls||0)+'</td>' +
      '<td>'+auto+(t.prompt_preview||'').replace(/</g,'&lt;').slice(0,80)+'</td>' +
      '</tr>';
  }).join('');
}

function filterRows() {
  const q = document.getElementById('search').value.toLowerCase();
  if (!q) { renderRows(allRows); return; }
  renderRows(allRows.filter(t =>
    (t.group_folder||'').toLowerCase().includes(q) ||
    (t.prompt_preview||'').toLowerCase().includes(q)
  ));
}

async function openTrace(id) {
  const [trace, llm, tools] = await Promise.all([
    fetch('/api/traces/'+id).then(r=>r.json()),
    fetch('/api/traces/'+id+'/llm').then(r=>r.json()),
    fetch('/api/traces/'+id+'/tools').then(r=>r.json()),
  ]);

  // Merge LLM calls and tool calls into a unified timeline sorted by start
  const events = [
    ...llm.map(c => ({ ...c, _kind:'llm' })),
    ...tools.map(c => ({ ...c, _kind:'tool' })),
  ].sort((a,b) => new Date(a.started_at)-new Date(b.started_at));

  let html = '<h2 style="margin-bottom:8px">Trace: '+id+'</h2>';
  html += '<p style="color:var(--muted);font-size:12px;margin-bottom:12px">';
  html += 'Group: <b>'+trace.group_folder+'</b> &nbsp;|&nbsp; ';
  html += 'Started: <b>'+fmt(trace.started_at)+'</b> &nbsp;|&nbsp; ';
  html += 'Duration: <b>'+dur(trace.started_at,trace.finished_at)+'</b> &nbsp;|&nbsp; ';
  html += 'Status: '+badge(trace.status);
  html += '</p>';
  if (trace.prompt_preview) {
    html += '<div style="background:#12151f;border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px;margin-bottom:16px;white-space:pre-wrap;word-break:break-word">';
    html += '<b style="color:var(--muted)">Prompt preview:</b>\\n'+trace.prompt_preview.replace(/</g,'&lt;');
    html += '</div>';
  }

  html += '<div class="timeline">';
  for (const ev of events) {
    if (ev._kind === 'llm') {
      html += '<div class="tl-item"><div class="tl-dot llm"></div><div class="tl-content">';
      html += '<div class="tl-header"><span class="tl-name">🤖 LLM call</span>';
      html += '<span class="tl-dur">'+dur(ev.started_at,ev.finished_at)+'</span></div>';
      if (ev.model) html += '<div class="tl-detail">model: '+ev.model+'</div>';
      html += '<div class="tl-detail tokens">in: <span>'+(ev.input_tokens||0)+'</span> &nbsp; out: <span>'+(ev.output_tokens||0)+'</span>';
      if (ev.stop_reason) html += ' &nbsp; stop: '+ev.stop_reason;
      html += '</div></div></div>';
    } else {
      const sub = ev.is_subagent ? ' <span style="color:var(--muted);font-size:10px">(subagent)</span>' : '';
      html += '<div class="tl-item"><div class="tl-dot tool"></div><div class="tl-content">';
      html += '<div class="tl-header"><span class="tl-name tool">🔧 '+ev.tool_name+sub+'</span>';
      html += '<span class="tl-dur">'+dur(ev.started_at,ev.finished_at)+'</span></div>';
      if (ev.input_preview) {
        html += '<div class="tl-detail" style="color:#aaa;max-height:200px;overflow-y:auto;background:#0a0c14;padding:6px 8px;border-radius:4px;margin-top:4px">▶ '+ev.input_preview.replace(/</g,'&lt;')+'</div>';
      }
      if (ev.output_preview) {
        html += '<div class="tl-detail" style="max-height:200px;overflow-y:auto;background:#0a0c14;padding:6px 8px;border-radius:4px;margin-top:4px">◀ '+ev.output_preview.replace(/</g,'&lt;')+'</div>';
      }
      html += '</div></div>';
    }
  }
  if (events.length === 0) html += '<div style="color:var(--muted);font-size:12px">No detailed events captured yet.</div>';
  html += '</div>';

  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});

loadStats();
loadAll();
setInterval(loadAll, 15000); // auto-refresh every 15s
</script>
</body>
</html>`;

export function startTraceServer(): void {
  const app = express();

  app.get('/', (_req, res) => res.send(HTML));
  app.get('/api/stats', (_req, res) => res.json(getStats()));
  app.get('/api/traces', (_req, res) => res.json(getTraces(100)));
  app.get('/api/traces/:id', (req, res) => {
    const t = getTrace(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    return res.json(t);
  });
  app.get('/api/traces/:id/llm', (req, res) =>
    res.json(getLlmCalls(req.params.id)),
  );
  app.get('/api/traces/:id/tools', (req, res) =>
    res.json(getToolCalls(req.params.id)),
  );

  app.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'Trace UI started');
  });
}
