export interface TaskStep {
  label: string;
  status: 'done' | 'active' | 'pending';
  output: string | null;
}

export interface TaskLog {
  time: string;
  level: 'success' | 'error' | 'info' | 'warn';
  text: string;
}

export interface TaskDetailData {
  taskId: string;
  title: string;
  status: 'active' | 'blocked' | 'complete';
  steps: TaskStep[];
  logs: TaskLog[];
  startedAt: string;
  findings?: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  success: '#3fb950',
  error: '#f85149',
  info: '#58a6ff',
  warn: '#f0883e',
};

const STATUS_ICONS: Record<string, string> = {
  done: '✓',
  active: '●',
  pending: '○',
};

export function renderTaskDetail(data: TaskDetailData): string {
  const stepsHtml = data.steps
    .map((s) => {
      const icon = STATUS_ICONS[s.status] || '○';
      const outputBlock = s.output
        ? `<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px;margin-top:4px;font-family:monospace;font-size:11px;color:#8b949e;">${escapeHtml(s.output)}</div>`
        : '';
      return `<div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex-shrink:0;font-size:14px;">${icon}</div><div><div style="font-size:14px;color:#c9d1d9;">${escapeHtml(s.label)}</div>${outputBlock}</div></div>`;
    })
    .join('');

  const logsHtml = data.logs
    .map((l) => {
      const color = LEVEL_COLORS[l.level] || '#8b949e';
      return `<div><span style="color:#484f58;">${escapeHtml(l.time)}</span> <span style="color:${color};">●</span> ${escapeHtml(l.text)}</div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; }
    .status { font-size: 12px; color: #f0883e; text-transform: uppercase; margin-bottom: 4px; }
    .logs { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; line-height: 1.6; max-height: 200px; overflow-y: auto; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body data-updated-at="${escapeHtml(data.startedAt)}">
  <div class="header">
    <div class="status">${data.status.toUpperCase()}</div>
    <div class="title">${escapeHtml(data.title)}</div>
  </div>
  <div style="margin-bottom:16px;">${stepsHtml}</div>
  <div class="logs">${logsHtml}</div>
  <div class="actions">
    <button class="btn">Pause</button>
    <button class="btn" style="color:#f85149;">Abort</button>
  </div>
  <script>
    const taskId = '${escapeHtml(data.taskId)}';
    const evtSource = new EventSource('/api/task/' + taskId + '/stream');

    evtSource.onmessage = function(event) {
      const state = JSON.parse(event.data);
      // Update status
      const statusEl = document.querySelector('.status');
      if (statusEl) statusEl.textContent = state.status.toUpperCase();

      // Reload page on significant changes (simple approach)
      // A production version would do granular DOM updates
      if (state.updated_at !== document.body.dataset.updatedAt) {
        document.body.dataset.updatedAt = state.updated_at;
        location.reload();
      }
    };

    evtSource.addEventListener('complete', function() {
      evtSource.close();
      const statusEl = document.querySelector('.status');
      if (statusEl) {
        statusEl.textContent = 'COMPLETE';
        statusEl.style.color = '#3fb950';
      }
    });

    evtSource.onerror = function() {
      evtSource.close();
    };
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
