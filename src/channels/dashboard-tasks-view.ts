/**
 * Scheduled tasks view — read-only list grouped by status, with
 * click-to-expand last_result snippets. Migrated to the shared
 * dashboard vocabulary in devtask #60 (Unit 6).
 *
 * Tasks rows are <div>s, not <button>s — there is no selection
 * concept in Tasks. The chevron is the only button in the row,
 * with aria-expanded / aria-controls on the .list-row__expanded
 * pre. Chevron click is stopPropagation'd so it never bubbles to
 * the row. Tasks with no last_result hide the chevron entirely.
 *
 * Expanded state is an in-memory Set<taskId> at module scope so
 * SSE re-fetches don't collapse rows the user just expanded.
 * State does NOT survive page reload (intentional — ephemeral).
 *
 * last_result is rendered via textContent on a <pre>, never
 * innerHTML — last_result is raw stdout from agent jobs and may
 * contain arbitrary HTML.
 */

export function getTasksViewHTML(): string {
  return `
<div class="view-shell">
  <header class="page-header">
    <div class="page-header__title-block">
      <h1 class="page-header__title">Scheduled Tasks</h1>
      <div class="page-header__meta" id="tasks-meta"></div>
    </div>
  </header>
  <div class="view-body tasks-shell">
    <div class="tasks-card" id="tasks-list"></div>
  </div>
</div>

<style>
.tasks-shell { padding-bottom: var(--spacing-xl); }
.tasks-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.tasks-card .list-row:last-child { border-bottom: none; }

.tasks-row {
  cursor: default;
}
.tasks-row__inner {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
  width: 100%;
}
.tasks-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tasks-row.is-active    { border-left-color: var(--green); border-left-width: 4px; }
.tasks-row.is-paused    { border-left-color: var(--orange); border-left-width: 4px; }
.tasks-row.is-completed { border-left-color: var(--text-tertiary); opacity: 0.65; }

.tasks-chevron {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  font-size: 16px;
  font-family: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, background 0.15s, color 0.15s;
}
.tasks-chevron:hover { background: var(--surface-hover); color: var(--text); }
.tasks-chevron:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tasks-chevron[aria-expanded="true"] { transform: rotate(90deg); color: var(--text); }

.tasks-result {
  margin: var(--spacing-sm) 0 0 0;
  padding: var(--spacing-md);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .tasks-card { border-radius: var(--radius-md); }
  .tasks-row__inner { gap: var(--spacing-sm); }
  .tasks-chevron { width: 36px; height: 36px; }
}
</style>
`;
}

export function getTasksViewJS(): string {
  return `
(function() {
  // Expanded-row state survives SSE re-fetches because the IIFE
  // persists across renders. Lost on page reload (intentional).
  var expanded = new Set();

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function humanCron(cron) {
    var p = cron.split(' ');
    if (p.length !== 5) return 'Scheduled (' + cron + ')';
    var min = p[0], hr = p[1], dom = p[2], mon = p[3], dow = p[4];
    function fmtTime(h, m) {
      var ampm = h >= 12 ? 'PM' : 'AM';
      var h12 = h % 12 || 12;
      return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }
    if (dom === '*' && mon === '*' && dow === '*' && !isNaN(hr) && !isNaN(min))
      return 'Daily at ' + fmtTime(+hr, +min);
    if (dom === '*' && mon === '*' && dow === '1-5' && !isNaN(hr) && !isNaN(min))
      return 'Weekdays at ' + fmtTime(+hr, +min);
    if (dom === '*' && mon === '*' && !isNaN(dow) && !isNaN(hr) && !isNaN(min)) {
      var days = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];
      if (+dow >= 0 && +dow < 7) return days[+dow] + ' at ' + fmtTime(+hr, +min);
    }
    if (min === '0' && hr.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
      return 'Every ' + hr.slice(2) + ' hours';
    }
    return 'Scheduled (' + cron + ')';
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return rm === 0 ? h + ' hr' : h + ' hr ' + rm + ' min';
  }

  function scheduleDesc(task) {
    if (task.schedule_type === 'once') {
      return 'Once — ' + relativeTime(task.schedule_value);
    }
    if (task.schedule_type === 'interval') {
      return 'Every ' + fmtDuration(+task.schedule_value);
    }
    return humanCron(task.schedule_value);
  }

  function relativeTime(iso) {
    if (!iso) return '—';
    try {
      var date = new Date(iso);
      var now = new Date();
      var diff = date - now;
      var absDiff = Math.abs(diff);
      if (absDiff < 60000) return diff > 0 ? 'in a moment' : 'just now';
      if (absDiff < 3600000) {
        var mins = Math.round(absDiff / 60000);
        return diff > 0 ? 'in ' + mins + ' min' : mins + ' min ago';
      }
      if (absDiff < 86400000) {
        var hrs = Math.round(absDiff / 3600000);
        return diff > 0 ? 'in ' + hrs + ' hr' : hrs + ' hr ago';
      }
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return iso; }
  }

  function promptSummary(prompt) {
    var line = (prompt || '').split('\\n')[0];
    return line.length > 120 ? line.slice(0, 117) + '...' : line;
  }

  var statusOrder = ['active', 'paused', 'completed'];
  var statusLabels = { active: 'Active', paused: 'Paused', completed: 'Completed' };

  function updateMeta(tasks) {
    var meta = document.getElementById('tasks-meta');
    if (!meta) return;
    var active = tasks.filter(function(t) { return t.status === 'active'; }).length;
    meta.textContent = active + ' active · ' + tasks.length + ' total';
  }

  function rowHTML(t) {
    var hasResult = !!(t.last_result && t.last_result.trim());
    var isExpanded = expanded.has(t.id);
    var expandedAttr = isExpanded ? 'true' : 'false';
    var expandedId = 'task-exp-' + esc(String(t.id));

    var metaParts = [];
    if (t.next_run) metaParts.push('<span>Next ' + esc(relativeTime(t.next_run)) + '</span>');
    if (t.last_run) metaParts.push('<span>Last ' + esc(relativeTime(t.last_run)) + '</span>');
    if (t.group_folder) metaParts.push('<span>' + esc(t.group_folder) + '</span>');
    var metaHTML = metaParts.length
      ? '<div class="list-row__meta">' + metaParts.join('') + '</div>'
      : '';

    var chevronHTML = hasResult
      ? '<button type="button" class="tasks-chevron" aria-expanded="' + expandedAttr +
        '" aria-controls="' + expandedId + '" aria-label="Show last result" data-task-id="' + esc(String(t.id)) + '">›</button>'
      : '';

    // last_result is intentionally NOT inserted via innerHTML — it's
    // raw stdout. Render path inserts via textContent after attaching.
    var hiddenAttr = isExpanded ? '' : ' hidden';
    var expandedHTML = hasResult
      ? '<pre class="tasks-result" id="' + expandedId + '" data-task-id="' + esc(String(t.id)) + '"' + hiddenAttr + '></pre>'
      : '';

    return '<div class="list-row tasks-row is-' + esc(t.status) + (isExpanded ? ' is-expanded' : '') + '">' +
        '<div class="tasks-row__inner">' +
          '<div class="tasks-row__main">' +
            '<div class="list-row__title">' + esc(promptSummary(t.prompt)) + '</div>' +
            '<div class="list-row__summary">' + esc(scheduleDesc(t)) + '</div>' +
            metaHTML +
          '</div>' +
          chevronHTML +
        '</div>' +
        expandedHTML +
      '</div>';
  }

  function renderTasks(data) {
    var el = document.getElementById('tasks-list');
    var tasks = (data.tasks || []).slice();
    updateMeta(tasks);

    if (tasks.length === 0) {
      el.innerHTML = '<div class="empty-state"><h3>All clear</h3><p>Pip and Pickle have nothing scheduled right now.</p></div>';
      return;
    }

    // Group by status
    var groups = { active: [], paused: [], completed: [] };
    tasks.forEach(function(t) {
      var s = (groups[t.status] ? t.status : 'active');
      groups[s].push(t);
    });

    var html = '';
    statusOrder.forEach(function(status) {
      var items = groups[status];
      if (!items || items.length === 0) return;
      html += '<div class="list-section list-section--' + esc(status) + '">' + esc(statusLabels[status]) +
        '<span class="list-section__count">' + items.length + '</span></div>';
      items.forEach(function(t) { html += rowHTML(t); });
    });

    el.innerHTML = html;

    // Inject last_result via textContent (NOT innerHTML).
    var byId = {};
    tasks.forEach(function(t) { byId[t.id] = t; });
    el.querySelectorAll('.tasks-result').forEach(function(pre) {
      var t = byId[pre.dataset.taskId] || byId[+pre.dataset.taskId];
      if (t && t.last_result) pre.textContent = t.last_result;
    });

    // Chevron click handlers (event delegation could work too, this
    // keeps the surface area small).
    el.querySelectorAll('.tasks-chevron').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.dataset.taskId;
        var key = isNaN(+id) ? id : +id;
        var pre = document.getElementById('task-exp-' + id);
        var row = btn.closest('.tasks-row');
        if (expanded.has(key)) {
          expanded.delete(key);
          btn.setAttribute('aria-expanded', 'false');
          if (pre) pre.setAttribute('hidden', 'hidden');
          if (row) row.classList.remove('is-expanded');
        } else {
          expanded.add(key);
          btn.setAttribute('aria-expanded', 'true');
          if (pre) pre.removeAttribute('hidden');
          if (row) row.classList.add('is-expanded');
        }
      });
    });
  }

  function loadTasks() {
    fetch('/dashboard/api/tasks')
      .then(function(r) { return r.json(); })
      .then(renderTasks)
      .catch(function(err) { console.error('Failed to load tasks:', err); });
  }

  var loaded = false;
  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'tasks' && !loaded) { loadTasks(); loaded = true; }
  });
  window.addEventListener('dashboard-tasks_updated', loadTasks);
  if (location.hash === '#tasks') { loadTasks(); loaded = true; }
})();
`;
}
