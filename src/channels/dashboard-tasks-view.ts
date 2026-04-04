/**
 * Scheduled tasks view — read-only list with status badges and human-readable schedules.
 */

export function getTasksViewHTML(): string {
  return `
<h2 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;margin-bottom:var(--spacing-lg);">Scheduled Tasks</h2>
<div id="tasks-list"></div>
`;
}

export function getTasksViewJS(): string {
  return `
(function() {
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
    return line.length > 80 ? line.slice(0, 77) + '...' : line;
  }

  var statusOrder = { active: 0, paused: 1, completed: 2 };

  function renderTasks(data) {
    var el = document.getElementById('tasks-list');
    var tasks = (data.tasks || []).sort(function(a, b) {
      return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
    });

    if (tasks.length === 0) {
      el.innerHTML = '<div class="empty-state"><h3>No scheduled tasks</h3><p>Tasks will appear here when agents create them.</p></div>';
      return;
    }

    var html = tasks.map(function(t) {
      return '<div class="card" style="display:flex;flex-direction:column;gap:8px;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span class="badge badge-' + esc(t.status) + '">' + esc(t.status) + '</span>' +
          '<span style="font-size:12px;color:var(--text-tertiary);">' + esc(t.schedule_type === 'cron' ? 'Recurring' : t.schedule_type === 'interval' ? 'Repeating' : 'One-time') + '</span>' +
          '<span style="font-size:12px;color:var(--text-tertiary);margin-left:auto;">' + esc(t.group_folder) + '</span>' +
        '</div>' +
        '<div style="font-size:15px;font-weight:600;">' + esc(promptSummary(t.prompt)) + '</div>' +
        '<div style="font-size:13px;color:var(--text-secondary);">' + esc(scheduleDesc(t)) + '</div>' +
        '<div style="display:flex;gap:16px;font-size:12px;color:var(--text-tertiary);">' +
          (t.next_run ? '<span>Next: ' + esc(relativeTime(t.next_run)) + '</span>' : '') +
          (t.last_run ? '<span>Last: ' + esc(relativeTime(t.last_run)) + '</span>' : '') +
        '</div>' +
        (t.last_result ? '<div style="font-size:12px;color:var(--text-tertiary);background:var(--surface-hover);padding:6px 10px;border-radius:var(--radius-sm);margin-top:4px;white-space:pre-wrap;max-height:60px;overflow:hidden;">' + esc(t.last_result.slice(0, 200)) + '</div>' : '') +
      '</div>';
    }).join('');

    el.innerHTML = html;
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
