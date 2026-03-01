import { getTasks, getTaskRunLogs } from '@/lib/db';
import { formatDateTime, timeAgo } from '@/lib/format';
import { TaskActions } from './actions';

export const dynamic = 'force-dynamic';

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-900/30 text-[var(--success)]',
    paused: 'bg-yellow-900/30 text-[var(--warning)]',
    completed: 'bg-[var(--bg)] text-[var(--text-muted)]',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${styles[status] || styles.completed}`}>
      {status}
    </span>
  );
}

function describeCron(expr: string): string {
  // Simple human-readable descriptions for common patterns
  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  if (dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*' && min === '*') return 'Every minute';
    if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
    return `Daily at ${hour}:${min.padStart(2, '0')} UTC`;
  }
  if (dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayNames = dow.split(',').map((d) => days[parseInt(d)] || d).join(', ');
    return `${dayNames} at ${hour}:${min.padStart(2, '0')} UTC`;
  }
  return expr;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ expanded?: string }>;
}) {
  const sp = await searchParams;
  const expandedTaskId = sp.expanded;

  const tasks = getTasks();
  const expandedLogs = expandedTaskId ? getTaskRunLogs(expandedTaskId) : [];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Scheduled Tasks</h1>

      <div className="space-y-4">
        {tasks.map((t) => {
          const isExpanded = t.id === expandedTaskId;

          return (
            <div
              key={t.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden"
            >
              <div className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm break-words">{t.prompt}</div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-muted)]">
                      <span>{t.group_folder}</span>
                      <span>
                        {t.schedule_type === 'cron'
                          ? describeCron(t.schedule_value)
                          : t.schedule_type === 'interval'
                            ? `every ${formatDuration(parseInt(t.schedule_value))}`
                            : `once at ${formatDateTime(t.schedule_value)}`}
                      </span>
                      {t.next_run && (
                        <span>next: {formatDateTime(t.next_run)}</span>
                      )}
                      {t.last_run && (
                        <span>last: {timeAgo(t.last_run)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={t.status} />
                    <TaskActions taskId={t.id} status={t.status} />
                  </div>
                </div>
              </div>

              {/* Expandable run logs */}
              <div className="border-t border-[var(--border)] px-4 py-2 text-xs">
                <a
                  href={isExpanded ? '/tasks' : `/tasks?expanded=${t.id}`}
                  className="text-[var(--accent)] hover:underline"
                >
                  {isExpanded ? 'Hide run history' : 'Show run history'}
                </a>
              </div>

              {isExpanded && expandedLogs.length > 0 && (
                <div className="border-t border-[var(--border)]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                        <th className="p-2 text-left">Run At</th>
                        <th className="p-2 text-left">Duration</th>
                        <th className="p-2 text-left">Status</th>
                        <th className="p-2 text-left">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedLogs.map((log) => (
                        <tr
                          key={log.id}
                          className="border-b border-[var(--border)]"
                        >
                          <td className="p-2">
                            {formatDateTime(log.run_at)}
                          </td>
                          <td className="p-2">
                            {formatDuration(log.duration_ms)}
                          </td>
                          <td className="p-2">
                            <span
                              className={
                                log.status === 'success'
                                  ? 'text-[var(--success)]'
                                  : 'text-[var(--error)]'
                              }
                            >
                              {log.status}
                            </span>
                          </td>
                          <td className="p-2 truncate max-w-xs text-[var(--text-muted)]">
                            {log.error || log.result?.slice(0, 100) || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {isExpanded && expandedLogs.length === 0 && (
                <div className="border-t border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
                  No run history yet
                </div>
              )}
            </div>
          );
        })}
        {tasks.length === 0 && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center text-[var(--text-muted)]">
            No scheduled tasks
          </div>
        )}
      </div>
    </div>
  );
}
