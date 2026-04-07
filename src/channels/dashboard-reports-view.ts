/**
 * Reports view — two-column list/detail layout with text filter and
 * date-group sticky headers.
 *
 * Mirrors dashboard-devtasks-view.ts for consistency with the rest of the
 * dashboard. Reads pre-rendered, pre-sanitized HTML from the reports API
 * and sets innerHTML directly on the detail pane.
 */

export function getReportsViewHTML(): string {
  return `
<div id="reports-container" style="display:flex;gap:0;height:100%;">
  <div id="reports-left" style="width:350px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;">
    <div style="padding:var(--spacing-lg);border-bottom:1px solid var(--border);">
      <input type="search" id="reports-filter" placeholder="Filter reports…" autocomplete="off"
        style="width:100%;padding:var(--spacing-sm) var(--spacing-md);font-size:14px;
               background:var(--surface-hover);border:1px solid var(--border);border-radius:6px;
               color:var(--text);outline:none;" />
    </div>
    <div id="reports-list" style="flex:1;overflow-y:auto;padding:var(--spacing-lg) 0;"></div>
  </div>
  <div id="reports-detail" style="flex:1;overflow-y:auto;padding:var(--spacing-xl);">
    <div class="empty-state" id="reports-empty-detail"><h3>Pick a report</h3><p>Tap any report on the left to read it.</p></div>
  </div>
</div>

<style>
@media (max-width: 768px) {
  #reports-container { flex-direction:column; }
  #reports-left { width:100%;border-right:none;border-bottom:1px solid var(--border);max-height:50vh; }
}
.rp-section-header {
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;
  color:var(--text-secondary);padding:var(--spacing-md) var(--spacing-lg) var(--spacing-xs);
  position:sticky;top:0;background:var(--surface);z-index:1;
}
.rp-row {
  display:flex;flex-direction:column;gap:4px;padding:var(--spacing-md) var(--spacing-lg);
  cursor:pointer;transition:background 0.15s;border-left:3px solid transparent;
  border-bottom:1px solid var(--border);
}
.rp-row:last-child { border-bottom:none; }
.rp-row:hover { background:var(--surface-hover); }
.rp-row.selected { background:var(--accent-light);border-left-color:var(--accent); }
.rp-row .rp-title { font-size:14px;font-weight:600;color:var(--text);line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
.rp-row .rp-summary { font-size:12px;color:var(--text-secondary);line-height:1.4;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
.rp-row .rp-meta { display:flex;align-items:center;gap:var(--spacing-sm);font-size:11px;
  color:var(--text-tertiary);margin-top:2px; }
.rp-badge { display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;
  font-weight:500;background:var(--surface-hover);color:var(--text-tertiary); }

.rp-detail-header { margin-bottom:var(--spacing-xl);padding-bottom:var(--spacing-lg);border-bottom:1px solid var(--border); }
.rp-detail-header h1 { font-size:26px;font-weight:700;letter-spacing:-0.3px;line-height:1.2;
  margin-bottom:var(--spacing-sm);color:var(--text); }
.rp-detail-summary { font-size:15px;color:var(--text-secondary);line-height:1.5;margin-bottom:var(--spacing-md); }
.rp-detail-meta { display:flex;align-items:center;gap:var(--spacing-md);font-size:12px;
  color:var(--text-tertiary); }

/* --- Rendered markdown: Tailwind Typography (prose) baseline --- */
.report-body { font-size:15px;line-height:1.7;color:var(--text);max-width:none; }
.report-body > * + * { margin-top:1.2em; }
.report-body h1, .report-body h2, .report-body h3, .report-body h4 {
  color:var(--text);font-weight:700;line-height:1.3;letter-spacing:-0.2px;
}
.report-body h1 { font-size:1.75em;margin-top:2em; }
.report-body h2 { font-size:1.4em;margin-top:1.8em; }
.report-body h3 { font-size:1.15em;margin-top:1.5em; }
.report-body h4 { font-size:1em;margin-top:1.3em; }
.report-body p { margin:0; }
.report-body strong { font-weight:600;color:var(--text); }
.report-body em { font-style:italic; }
.report-body a { color:var(--accent);text-decoration:underline;text-underline-offset:2px; }
.report-body a:hover { text-decoration:none; }
.report-body ul, .report-body ol { padding-left:1.5em; }
.report-body ul { list-style:disc; }
.report-body ol { list-style:decimal; }
.report-body li { margin-top:0.4em; }
.report-body li > p { margin-top:0.4em; }
.report-body blockquote {
  border-left:3px solid var(--border);padding-left:1em;font-style:italic;color:var(--text-secondary);
}
.report-body code {
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-size:0.88em;background:var(--surface-hover);padding:1px 5px;border-radius:4px;
}
.report-body pre {
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-size:0.88em;background:var(--surface-hover);padding:var(--spacing-md) var(--spacing-lg);
  border-radius:6px;overflow-x:auto;line-height:1.5;
}
.report-body pre code { background:transparent;padding:0;font-size:1em; }
.report-body table {
  border-collapse:collapse;width:100%;font-size:0.92em;
}
.report-body th, .report-body td {
  padding:var(--spacing-sm) var(--spacing-md);border:1px solid var(--border);text-align:left;vertical-align:top;
}
.report-body th { background:var(--surface-hover);font-weight:600; }
.report-body hr { border:none;border-top:1px solid var(--border);margin:2em 0; }
</style>
`;
}

export function getReportsViewJS(): string {
  return `
(function() {
  var allReports = [];
  var selectedId = null;
  var filterText = '';
  var loaded = false;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      var date = new Date(iso);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' · ' +
        date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch { return iso; }
  }

  function dayBucket(iso) {
    // Client-side date grouping: Today / This week / This month / Older.
    // Uses local time so "Today" matches the reader's wall clock.
    try {
      var now = new Date();
      var d = new Date(iso);
      var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      var ts = d.getTime();
      if (ts >= startOfToday) return 'Today';

      var weekStart = new Date(startOfToday);
      var dow = weekStart.getDay(); // 0=Sun
      weekStart.setDate(weekStart.getDate() - dow);
      if (ts >= weekStart.getTime()) return 'This week';

      var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      if (ts >= monthStart) return 'This month';

      return 'Older';
    } catch { return 'Older'; }
  }

  function matchesFilter(report) {
    if (!filterText) return true;
    var q = filterText.toLowerCase();
    return (report.title || '').toLowerCase().indexOf(q) !== -1 ||
           (report.summary || '').toLowerCase().indexOf(q) !== -1;
  }

  function renderList() {
    var el = document.getElementById('reports-list');
    if (!el) return;

    var visible = allReports.filter(matchesFilter);

    if (visible.length === 0) {
      if (filterText) {
        el.innerHTML = '<div class="empty-state" style="padding:var(--spacing-xl);"><h3>No matches</h3><p>No reports match "' + esc(filterText) + '".</p></div>';
      } else {
        el.innerHTML = '<div class="empty-state" style="padding:var(--spacing-xl);"><h3>No reports yet</h3><p>Pip will write reports here when you ask for research, comparisons, or option analyses.</p></div>';
      }
      return;
    }

    // Group by bucket, preserving newest-first order within each group
    var order = ['Today', 'This week', 'This month', 'Older'];
    var groups = { 'Today': [], 'This week': [], 'This month': [], 'Older': [] };
    visible.forEach(function(r) {
      var b = dayBucket(r.created_at);
      (groups[b] || groups['Older']).push(r);
    });

    var html = '';
    order.forEach(function(bucket) {
      var items = groups[bucket];
      if (!items || items.length === 0) return;
      html += '<div class="rp-section-header">' + esc(bucket) + '</div>';
      items.forEach(function(r) {
        var sel = selectedId === r.id ? ' selected' : '';
        var summary = r.summary ? '<div class="rp-summary">' + esc(r.summary) + '</div>' : '';
        var badge = r.created_by ? '<span class="rp-badge">' + esc(r.created_by) + '</span>' : '';
        html += '<div class="rp-row' + sel + '" data-id="' + esc(r.id) + '">' +
          '<div class="rp-title">' + esc(r.title) + '</div>' +
          summary +
          '<div class="rp-meta"><span>' + esc(formatDate(r.created_at)) + '</span>' + badge + '</div>' +
        '</div>';
      });
    });

    el.innerHTML = html;

    el.querySelectorAll('.rp-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var id = row.dataset.id;
        selectReport(id);
        // Update hash deep-link. The global hash router derives the view
        // from the prefix before '/' and does not rewrite the hash, so
        // the suffix survives.
        location.hash = 'reports/' + id;
      });
    });
  }

  function selectReport(id) {
    selectedId = id;
    // Update selection visual state without a full list re-render
    var el = document.getElementById('reports-list');
    if (el) {
      el.querySelectorAll('.rp-row').forEach(function(r) {
        r.classList.toggle('selected', r.dataset.id === id);
      });
    }
    loadReport(id);
  }

  function renderDetailEmpty(msg) {
    var el = document.getElementById('reports-detail');
    if (!el) return;
    el.innerHTML = '<div class="empty-state"><h3>' + esc(msg || 'Pick a report') + '</h3><p>Tap any report on the left to read it.</p></div>';
  }

  function renderDetailNotFound() {
    var el = document.getElementById('reports-detail');
    if (!el) return;
    el.innerHTML = '<div class="empty-state"><h3>Report not found</h3><p>This report may have been removed.</p></div>';
  }

  function loadReport(id) {
    fetch('/dashboard/api/reports/' + encodeURIComponent(id))
      .then(function(r) {
        if (r.status === 404) { renderDetailNotFound(); return null; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        var el = document.getElementById('reports-detail');
        if (!el) return;
        var badge = data.created_by ? '<span class="rp-badge">' + esc(data.created_by) + '</span>' : '';
        var summary = data.summary ? '<div class="rp-detail-summary">' + esc(data.summary) + '</div>' : '';
        // body_html is server-side sanitized (marked + sanitize-html allowlist)
        el.innerHTML =
          '<div class="rp-detail-header">' +
            '<h1>' + esc(data.title) + '</h1>' +
            summary +
            '<div class="rp-detail-meta"><span>' + esc(formatDate(data.created_at)) + '</span>' + badge + '</div>' +
          '</div>' +
          '<div class="report-body">' + (data.body_html || '') + '</div>';
      })
      .catch(function(err) {
        console.error('Failed to load report:', err);
        var el = document.getElementById('reports-detail');
        if (el) el.innerHTML = '<div class="empty-state"><h3>Failed to load</h3><p>' + esc(err.message) + '</p></div>';
      });
  }

  function loadReports() {
    fetch('/dashboard/api/reports')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        allReports = data.reports || [];
        renderList();
        // Re-render currently-open report if still present
        if (selectedId) {
          var still = allReports.find(function(r) { return r.id === selectedId; });
          if (still) loadReport(selectedId);
        }
      })
      .catch(function(err) { console.error('Failed to load reports:', err); });
  }

  // Filter input
  document.addEventListener('input', function(e) {
    if (e.target && e.target.id === 'reports-filter') {
      filterText = e.target.value || '';
      renderList();
    }
  });

  function parseReportIdFromHash() {
    var h = location.hash.slice(1);
    if (h.indexOf('reports/') !== 0) return null;
    var id = h.slice('reports/'.length);
    return id || null;
  }

  function handleHashForView() {
    var id = parseReportIdFromHash();
    if (id && id !== selectedId) {
      selectedId = id;
      loadReport(id);
      // Highlight after next list render
      var el = document.getElementById('reports-list');
      if (el) {
        el.querySelectorAll('.rp-row').forEach(function(r) {
          r.classList.toggle('selected', r.dataset.id === id);
        });
      }
    }
  }

  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'reports') {
      if (!loaded) { loadReports(); loaded = true; }
      handleHashForView();
    }
  });

  window.addEventListener('hashchange', function() {
    if (location.hash.indexOf('#reports') === 0) {
      handleHashForView();
    }
  });

  window.addEventListener('dashboard-reports_updated', loadReports);

  if (location.hash.indexOf('#reports') === 0) {
    loadReports();
    loaded = true;
    // Defer ID resolution until the list is populated
    setTimeout(handleHashForView, 50);
  }
})();
`;
}
