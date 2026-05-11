import React, { useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { listTasks } from '../lib/api.js';
import { subscribe, startSSE } from '../lib/sse.ts';
import type { AuthMe, TaskSummary } from '../lib/api.js';

interface KanbanBoardProps {
  authMe: AuthMe;
}

type Status = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

const LANES: { status: Status; label: string; color: string }[] = [
  { status: 'pending',   label: 'Pending',   color: '#f5a623' },
  { status: 'running',   label: 'Running',   color: '#4a90e2' },
  { status: 'completed', label: 'Completed', color: '#417505' },
  { status: 'failed',    label: 'Failed',    color: '#d0021b' },
  { status: 'cancelled', label: 'Cancelled', color: '#9b9b9b' },
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
        overflowX: 'auto',
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
              minWidth: isMobile ? undefined : 180,
              background: '#fafafa',
              borderTop: `3px solid ${color}`,
              borderRadius: 4,
              padding: 8,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, color }}>
              {label} <span style={{ fontWeight: 400, color: '#666' }}>({laneTasks.length})</span>
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

function TaskCard({ task }: { task: TaskSummary }) {
  const handleClick = () => {
    location.hash = `#/task/${task.task_id}`;
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      style={{
        background: '#fff',
        border: '1px solid #e0e0e0',
        borderRadius: 4,
        padding: 8,
        marginBottom: 6,
        cursor: 'pointer',
        fontSize: 13,
      }}
    >
      <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#666', marginBottom: 2 }}>
        {truncate(task.task_id, 16)}
      </div>
      <div style={{ marginBottom: 2 }}>{truncate(task.task_content, 80)}</div>
      <div style={{ fontSize: 11, color: '#999' }}>{relativeTime(task.admitted_at)}</div>
      {task.last_progress_message && (
        <div style={{ fontSize: 11, color: '#4a90e2', marginTop: 2 }}>
          {truncate(task.last_progress_message, 60)}
        </div>
      )}
      {task.fail_reason && (
        <div style={{ fontSize: 11, color: '#d0021b', marginTop: 2 }}>
          {truncate(task.fail_reason, 60)}
        </div>
      )}
    </div>
  );
}

export { startSSE };
