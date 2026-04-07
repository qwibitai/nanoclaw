/**
 * Dev tasks view — two-column list/detail layout with status grouping.
 * Migrated to the shared dashboard vocabulary in devtask #60.
 */

export function getDevTasksViewHTML(): string {
  return `
<div class="view-shell">
  <header class="page-header">
    <div class="page-header__title-block">
      <h1 class="page-header__title">Dev Tasks</h1>
      <div class="page-header__meta" id="devtasks-meta"></div>
    </div>
  </header>
  <div class="list-detail" id="devtasks-detail-shell">
    <div class="list-detail__list" id="devtasks-list"></div>
    <div class="list-detail__detail" id="devtasks-detail">
      <div class="list-detail__empty" id="devtasks-empty-detail">
        <h3>Pick a task</h3>
        <p>Tap any task on the left to see the full picture.</p>
      </div>
    </div>
  </div>
</div>

<style>
.devtasks-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  align-items: center;
  margin-bottom: var(--spacing-lg);
}
.devtasks-pr-link {
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
  word-break: break-all;
}
.devtasks-pr-link:hover { text-decoration: underline; }
.devtasks-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
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
    working:       { label: 'Working', order: 0 },
    open:          { label: 'Open', order: 1 },
    needs_session: { label: 'Needs Session', order: 2 },
    pr_ready:      { label: 'PR Ready', order: 3 },
    has_followups: { label: 'Has Follow-ups', order: 4 },
    done:          { label: 'Done', order: 5 }
  };

  function relativeTime(iso) {
    if (!iso) return '';
    try {
      var date = new Date(iso);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return iso; }
  }

  function updateMeta(tasks) {
    var meta = document.getElementById('devtasks-meta');
    if (!meta) return;
    var working = tasks.filter(function(t) { return t.status === 'working'; }).length;
    var total = tasks.length;
    meta.textContent = working + ' working · ' + total + ' total';
  }

  function renderList(tasks) {
    var el = document.getElementById('devtasks-list');

    if (tasks.length === 0) {
      el.innerHTML = '<div class="list-detail__empty"><h3>No dev tasks</h3><p>Tasks will appear here when created.</p></div>';
      return;
    }

    // Group by status
    var groups = {};
    tasks.forEach(function(t) {
      var s = t.status || 'open';
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    var orderedStatuses = Object.keys(groups).sort(function(a, b) {
      return (statusConfig[a] ? statusConfig[a].order : 9) - (statusConfig[b] ? statusConfig[b].order : 9);
    });

    var html = '';
    orderedStatuses.forEach(function(status) {
      var cfg = statusConfig[status] || { label: status, order: 9 };
      var items = groups[status];
      html += '<div class="list-section list-section--' + esc(status) + '">' + esc(cfg.label) +
        '<span class="list-section__count">' + items.length + '</span></div>';
      items.forEach(function(t) {
        var sel = selectedId === t.id ? ' is-selected' : '';
        html += '<button type="button" class="list-row' + sel + '" data-id="' + t.id + '">' +
          '<div class="list-row__title">' + esc(t.title) + '</div>' +
          '<div class="list-row__meta">' +
            '<span class="badge badge-completed">#' + t.id + '</span>' +
            (t.updated_at ? '<span>' + esc(relativeTime(t.updated_at)) + '</span>' : '') +
          '</div>' +
        '</button>';
      });
    });

    el.innerHTML = html;

    el.querySelectorAll('.list-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var id = parseInt(row.dataset.id);
        selectedId = id;
        var task = tasks.find(function(t) { return t.id === id; });
        if (task) renderDetail(task);
        el.querySelectorAll('.list-row').forEach(function(r) { r.classList.remove('is-selected'); });
        row.classList.add('is-selected');
        var shell = document.getElementById('devtasks-detail-shell');
        if (shell) shell.classList.add('is-detail-open');
      });
    });
  }

  function renderDetail(task) {
    var el = document.getElementById('devtasks-detail');
    var cfg = statusConfig[task.status] || { label: task.status };

    var meta = '<div class="detail-header__meta">';
    meta += '<span class="badge badge-' + esc(task.status) + '">' + esc(cfg.label) + '</span>';
    meta += '<span>#' + task.id + '</span>';
    meta += '<span>Created ' + esc(relativeTime(task.created_at)) + '</span>';
    if (task.updated_at) meta += '<span>Updated ' + esc(relativeTime(task.updated_at)) + '</span>';
    if (task.source) meta += '<span>via ' + esc(task.source) + '</span>';
    meta += '</div>';

    var subMeta = '';
    if (task.branch || task.pr_url) {
      subMeta += '<div class="devtasks-links">';
      if (task.branch) subMeta += '<span class="code-chip">' + esc(task.branch) + '</span>';
      if (task.pr_url) subMeta += '<a class="devtasks-pr-link" href="' + esc(task.pr_url) + '" target="_blank" rel="noopener">' + esc(task.pr_url.replace('https://github.com/', '')) + '</a>';
      subMeta += '</div>';
    }

    el.innerHTML = '<button type="button" class="list-detail__back" id="devtasks-back">Tasks</button>' +
      '<header class="detail-header">' +
        '<div class="detail-header__title-block">' +
          '<div class="detail-header__eyebrow">Dev Task</div>' +
          '<h2 class="detail-header__title">' + esc(task.title) + '</h2>' +
          meta +
        '</div>' +
      '</header>' +
      subMeta +
      (task.description
        ? '<div class="section-title">Description</div><div class="devtasks-body">' + esc(task.description) + '</div>'
        : '');

    var back = document.getElementById('devtasks-back');
    if (back) {
      back.addEventListener('click', function() {
        var shell = document.getElementById('devtasks-detail-shell');
        if (shell) shell.classList.remove('is-detail-open');
      });
    }
  }

  var allTasks = [];

  function loadDevTasks() {
    fetch('/dashboard/api/devtasks')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        allTasks = data.tasks || [];
        updateMeta(allTasks);
        renderList(allTasks);
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
