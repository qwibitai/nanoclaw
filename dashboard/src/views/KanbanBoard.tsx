import React, { useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { listTasks } from '../lib/api.js';
import { subscribe, startSSE } from '../lib/sse.ts';
import { renderMarkdown } from '../lib/markdown.js';
import type { AuthMe, TaskSummary } from '../lib/api.js';

interface KanbanBoardProps {
  authMe: AuthMe;
}

type Status = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

const LANES: { status: Status; label: string; color: string }[] = [
  { status: 'pending',   label: 'Pending',   color: 'var(--status-pending)' },
  { status: 'running',   label: 'Running',   color: 'var(--status-running)' },
  { status: 'completed', label: 'Completed', color: 'var(--status-completed)' },
  { status: 'failed',    label: 'Failed',    color: 'var(--status-failed)' },
  { status: 'cancelled', label: 'Cancelled', color: 'var(--status-cancelled)' },
];

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const CARD_PREVIEW_CHARS = 240;

const MOBILE_QUERY = '(max-width: 800px)';

export const KanbanBoard: React.FC<KanbanBoardProps> = ({ authMe: _authMe }) => {
  const { data, mutate } = useSWR('/dashboard/api/tasks', () => listTasks());

  const invalidate = useCallback(() => { void mutate(); }, [mutate]);

  useEffect(() => {
    const unsub = subscribe('task_event', invalidate);
    return unsub;
  }, [invalidate]);

  const [isMobile, setIsMobile] = React.useState(
    () => window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const tasks = data?.tasks ?? [];

  const tasksByStatus = (status: Status): TaskSummary[] =>
    tasks.filter((t) => t.status === status);

  return (
    <div
      className={isMobile ? 'kanban-mobile' : 'kanban-desktop'}
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: 12,
        padding: 16,
        // Desktop: horizontal scroll for 5 lanes side-by-side.
        // Mobile: stacked lanes — the document scrolls; no inner overflow
        // box (caused viewport-clipping of bottom lanes on phones).
        overflowX: isMobile ? 'visible' : 'auto',
      }}
    >
      {LANES.map(({ status, label, color }) => {
        const laneTasks = tasksByStatus(status);
        return (
          <div
            key={status}
            data-lane={status}
            style={{
              flex: isMobile ? 'none' : '1 1 0',
              minWidth: isMobile ? undefined : 200,
              background: 'var(--bg-lane)',
              border: '1px solid var(--border)',
              borderTop: `3px solid ${color}`,
              borderRadius: 6,
              padding: 10,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, color, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {label} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({laneTasks.length})</span>
            </div>
            {laneTasks.map((task) => (
              <TaskCard key={task.task_id} task={task} />
            ))}
          </div>
        );
      })}
    </div>
  );
};

function failPillColor(): { bg: string; fg: string } {
  return { bg: 'rgba(248, 81, 73, 0.15)', fg: 'var(--status-failed)' };
}

function TaskCard({ task }: { task: TaskSummary }) {
  const handleClick = () => {
    location.hash = `#/task/${task.task_id}`;
  };

  // Preview is a markdown render of the brief, capped to CARD_PREVIEW_CHARS
  // before the marked parse so we don't pay tokenizer cost on long briefs.
  const previewSrc = truncate(task.task_content, CARD_PREVIEW_CHARS);
  const previewHtml = renderMarkdown(previewSrc);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 10,
        marginBottom: 8,
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        {truncate(task.task_id, 18)}
      </div>
      <div
        className="md md-preview"
        style={{ marginBottom: 6 }}
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span>{relativeTime(task.admitted_at)}</span>
        {task.fail_reason && (
          <span className="pill" style={(() => { const c = failPillColor(); return { background: c.bg, color: c.fg }; })()}>
            {truncate(task.fail_reason, 28)}
          </span>
        )}
      </div>
      {task.last_progress_message && (
        <div style={{ fontSize: 11, color: 'var(--status-running)', marginTop: 4 }}>
          {truncate(task.last_progress_message, 80)}
        </div>
      )}
    </div>
  );
}

export { startSSE };
