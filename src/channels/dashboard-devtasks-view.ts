/**
 * Dev tasks view — two-column list/detail layout with status grouping.
 * Ported from FamBot's TaskListView.swift.
 */

export function getDevTasksViewHTML(): string {
  return `
<div id="devtasks-container" style="display:flex;gap:0;height:100%;">
  <div id="devtasks-list" style="width:350px;flex-shrink:0;border-right:1px solid var(--border);overflow-y:auto;padding:var(--spacing-lg) 0;"></div>
  <div id="devtasks-detail" style="flex:1;overflow-y:auto;padding:var(--spacing-xl);">
    <div class="empty-state" id="devtasks-empty-detail"><h3>Select a task</h3><p>Choose a task from the list to see details.</p></div>
  </div>
</div>

<style>
@media (max-width: 768px) {
  #devtasks-container { flex-direction:column; }
  #devtasks-list { width:100%;border-right:none;border-bottom:1px solid var(--border);max-height:50vh; }
}
.dt-section-header {
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;
  color:var(--text-secondary);padding:var(--spacing-md) var(--spacing-lg) var(--spacing-xs);
  display:flex;align-items:center;gap:8px;
}
.dt-section-header .count {
  font-size:10px;font-weight:700;background:var(--surface-hover);color:var(--text-tertiary);
  padding:1px 6px;border-radius:10px;
}
.dt-row {
  display:flex;align-items:flex-start;gap:var(--spacing-md);padding:var(--spacing-md) var(--spacing-lg);
  cursor:pointer;transition:background 0.1s;border-left:3px solid transparent;
}
.dt-row:hover { background:var(--surface-hover); }
.dt-row.selected { background:var(--accent-light);border-left-color:var(--accent); }
.dt-row .dt-id { min-width:36px; }
.dt-row .dt-title { font-size:14px;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
.dt-row .dt-status-text { font-size:12px;color:var(--text-tertiary);margin-top:2px; }
.dt-detail-header { margin-bottom:var(--spacing-xl); }
.dt-detail-header h2 { font-size:22px;font-weight:700;letter-spacing:-0.3px;margin-bottom:var(--spacing-sm); }
.dt-detail-meta { display:flex;flex-wrap:wrap;gap:var(--spacing-md);margin-top:var(--spacing-md); }
.dt-detail-meta .meta-item { font-size:13px;color:var(--text-secondary); }
.dt-detail-meta .meta-item strong { color:var(--text);font-weight:600; }
.dt-detail-meta a { color:var(--accent);text-decoration:none; }
.dt-detail-meta a:hover { text-decoration:underline; }
.dt-detail-body { font-size:14px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap; }
</style>
`;
}

export function getDevTasksViewJS(): string {
  return `
(function() {
  var selectedId = null;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  var statusConfig = {
    working:       { label: 'Working', text: 'Working...', order: 0 },
    open:          { label: 'Open', text: '', order: 1 },
    needs_session: { label: 'Needs Session', text: 'Needs session', order: 2 },
    pr_ready:      { label: 'PR Ready', text: 'PR ready for review', order: 3 },
    has_followups: { label: 'Has Follow-ups', text: 'Has follow-ups', order: 4 },
    done:          { label: 'Done', text: '', order: 5 }
  };

  function relativeTime(iso) {
    if (!iso) return '';
    try {
      var date = new Date(iso);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return iso; }
  }

  function renderList(tasks) {
    var el = document.getElementById('devtasks-list');

    if (tasks.length === 0) {
      el.innerHTML = '<div class="empty-state"><h3>No dev tasks</h3><p>Tasks will appear here when created.</p></div>';
      return;
    }

    // Group by status
    var groups = {};
    tasks.forEach(function(t) {
      var s = t.status || 'open';
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    // Sort groups by status order
    var orderedStatuses = Object.keys(groups).sort(function(a, b) {
      return (statusConfig[a] ? statusConfig[a].order : 9) - (statusConfig[b] ? statusConfig[b].order : 9);
    });

    var html = '';
    orderedStatuses.forEach(function(status) {
      var cfg = statusConfig[status] || { label: status, text: '', order: 9 };
      var items = groups[status];
      html += '<div class="dt-section-header">' + esc(cfg.label) + '<span class="count">' + items.length + '</span></div>';
      items.forEach(function(t) {
        var sel = selectedId === t.id ? ' selected' : '';
        var statusText = cfg.text ? '<div class="dt-status-text">' + esc(cfg.text) + '</div>' : '';
        html += '<div class="dt-row' + sel + '" data-id="' + t.id + '">' +
          '<span class="dt-id"><span class="badge badge-' + esc(t.status) + '">#' + t.id + '</span></span>' +
          '<div><div class="dt-title">' + esc(t.title) + '</div>' + statusText + '</div>' +
        '</div>';
      });
    });

    el.innerHTML = html;

    // Click handlers
    el.querySelectorAll('.dt-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var id = parseInt(row.dataset.id);
        selectedId = id;
        var task = tasks.find(function(t) { return t.id === id; });
        if (task) renderDetail(task);
        el.querySelectorAll('.dt-row').forEach(function(r) { r.classList.remove('selected'); });
        row.classList.add('selected');
      });
    });
  }

  function renderDetail(task) {
    var el = document.getElementById('devtasks-detail');
    var cfg = statusConfig[task.status] || { label: task.status };

    var meta = '<div class="dt-detail-meta">';
    meta += '<div class="meta-item"><strong>Status:</strong> <span class="badge badge-' + esc(task.status) + '">' + esc(cfg.label) + '</span></div>';
    if (task.branch) meta += '<div class="meta-item"><strong>Branch:</strong> <code style="font-size:12px;background:var(--surface-hover);padding:2px 6px;border-radius:4px;">' + esc(task.branch) + '</code></div>';
    if (task.pr_url) meta += '<div class="meta-item"><strong>PR:</strong> <a href="' + esc(task.pr_url) + '" target="_blank" rel="noopener">' + esc(task.pr_url.replace('https://github.com/', '')) + '</a></div>';
    if (task.source) meta += '<div class="meta-item"><strong>Source:</strong> ' + esc(task.source) + '</div>';
    meta += '<div class="meta-item"><strong>Created:</strong> ' + esc(relativeTime(task.created_at)) + '</div>';
    if (task.updated_at) meta += '<div class="meta-item"><strong>Updated:</strong> ' + esc(relativeTime(task.updated_at)) + '</div>';
    meta += '</div>';

    el.innerHTML = '<div class="dt-detail-header"><h2>' + esc(task.title) + '</h2>' + meta + '</div>' +
      (task.description ? '<div class="section-title">Description</div><div class="dt-detail-body">' + esc(task.description) + '</div>' : '');
  }

  var allTasks = [];

  function loadDevTasks() {
    fetch('/dashboard/api/devtasks')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        allTasks = data.tasks || [];
        renderList(allTasks);
        // Re-select current task if it still exists
        if (selectedId) {
          var task = allTasks.find(function(t) { return t.id === selectedId; });
          if (task) renderDetail(task);
        }
      })
      .catch(function(err) { console.error('Failed to load dev tasks:', err); });
  }

  var loaded = false;
  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'devtasks' && !loaded) { loadDevTasks(); loaded = true; }
  });
  window.addEventListener('dashboard-devtasks_updated', loadDevTasks);
  if (location.hash === '#devtasks') { loadDevTasks(); loaded = true; }
})();
`;
}
