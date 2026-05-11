import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import { getTask, postSteer } from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import type { AuthMe } from '../lib/api.js';

interface TaskDetailProps {
  authMe: AuthMe;
  taskId: string;
}

const MOBILE_QUERY = '(max-width: 800px)';
const MAX_CHARS = 4000;

export const TaskDetail: React.FC<TaskDetailProps> = ({ authMe: _authMe, taskId }) => {
  const { data, mutate } = useSWR(
    `/dashboard/api/tasks/${taskId}`,
    () => getTask(taskId)
  );

  const invalidate = useCallback(() => { void mutate(); }, [mutate]);

  // Filter SSE inbound_message by child_session_id (post-build QA fix SF-8).
  // Backend chokidar emits task_id='' for filesystem events (it doesn't have a
  // task row at fs-watch time), so the previous check `!payload.task_id || ===`
  // always invalidated for every fs change → every TaskDetail across all open
  // tabs refetched on every chokidar tick. Match on child_session_id instead;
  // backend always emits a real session id.
  const childSessionId = data?.task?.child_session_id;
  useEffect(() => {
    const unsub = subscribe<{ task_id?: string; child_session_id?: string }>(
      'inbound_message',
      (payload) => {
        if (payload.task_id === taskId) {
          invalidate();
          return;
        }
        // chokidar event (task_id == ''): only invalidate if the changed session
        // is THIS task's child session.
        if (childSessionId && payload.child_session_id === childSessionId) {
          invalidate();
        }
      },
    );
    return unsub;
  }, [invalidate, taskId, childSessionId]);

  useEffect(() => {
    const unsub = subscribe<{ task_id?: string }>('task_event', (payload) => {
      // task_event always carries a real task_id from dispatch/completion/etc.
      if (!payload.task_id || payload.task_id === taskId) invalidate();
    });
    return unsub;
  }, [invalidate, taskId]);

  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [text, setText] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const tooLong = text.length > MAX_CHARS;
  const isEmpty = !text.trim();
  const canSubmit = !isEmpty && !tooLong && !submitting;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await postSteer(taskId, { idempotency_key: idempotencyKey, text });
      setText('');
      setIdempotencyKey(crypto.randomUUID());
      void mutate();
    } catch (err: unknown) {
      const apiErr = err as { status?: number; error?: string; retry_after?: number };
      if (apiErr.status === 422) {
        setSubmitError('Idempotency conflict; please try again.');
        setIdempotencyKey(crypto.randomUUID());
        setText('');
      } else if (apiErr.status === 429) {
        const retryAfter = apiErr.retry_after ?? 60;
        setSubmitError(`Rate limited; try again in ${retryAfter}s`);
      } else {
        setSubmitError('Send failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      void handleSubmit();
    }
  };

  // Scroll thread to bottom on new messages
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [data]);

  const task = data?.task;
  const transcript = data?.transcript ?? [];

  if (!task) {
    return <div style={{ padding: 16 }}>Loading…</div>;
  }

  const metadata = (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Task</h2>
      <table style={{ fontSize: 13, borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          <MetaRow label="ID" value={task.task_id} mono />
          <MetaRow label="Status" value={task.status} />
          <MetaRow label="Session" value={task.parent_session_id} mono />
          <MetaRow label="Admitted" value={task.admitted_at} />
          {task.started_at && <MetaRow label="Started" value={task.started_at} />}
          {task.completed_at && <MetaRow label="Completed" value={task.completed_at} />}
          {task.fail_reason && <MetaRow label="Failure" value={task.fail_reason} />}
        </tbody>
      </table>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Content</div>
        <div style={{ fontSize: 13 }}>{task.task_content}</div>
      </div>
    </div>
  );

  const thread = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 16,
      }}
    >
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Thread</h2>
      <div
        ref={threadRef}
        style={{ flex: 1, overflowY: 'auto', marginBottom: 12 }}
        role="log"
        aria-label="Task thread"
      >
        {transcript.map((entry) => {
          // Backend shape (post-build QA fix MF-4): {id, seq, kind, timestamp, content, direction, source}.
          // We render the human-readable text out of `content` (usually has a `text` field
          // for chat/dashboard messages; falls back to JSON-stringify for system/agent envelopes).
          const text = (() => {
            if (typeof entry.content === 'string') return entry.content;
            if (entry.content && typeof entry.content === 'object') {
              const t = (entry.content as { text?: unknown }).text;
              if (typeof t === 'string') return t;
            }
            try {
              return JSON.stringify(entry.content);
            } catch {
              return '';
            }
          })();

          // Display timestamp in a stable HH:MM:SS form. Date.parse handles both
          // host ISO (2026-05-10T12:34:56.789Z) and container 'YYYY-MM-DD HH:MM:SS'.
          const ts = (() => {
            const ms = Date.parse(entry.timestamp);
            if (Number.isNaN(ms)) return entry.timestamp;
            return new Date(ms).toLocaleTimeString();
          })();

          // Right-align dashboard outbound messages (user-side echoes); everything else left.
          const isUserSide = entry.source === 'dashboard';
          const bg =
            entry.source === 'dashboard'
              ? '#f0f4ff'
              : entry.source === 'system'
                ? '#fff8e1'
                : '#f9f9f9';

          return (
            <div
              key={entry.id}
              style={{
                marginBottom: 8,
                padding: '6px 10px',
                borderRadius: 4,
                background: bg,
                fontSize: 13,
                textAlign: isUserSide ? 'right' : 'left',
              }}
            >
              <div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>
                {entry.source} · {entry.direction} · {ts}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
            </div>
          );
        })}
      </div>
      <form onSubmit={(e) => void handleSubmit(e)} style={{ borderTop: '1px solid #e0e0e0', paddingTop: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_CHARS + 100}
          placeholder="Steer the task… (Cmd+Enter to send)"
          rows={3}
          style={{
            width: '100%',
            padding: 8,
            boxSizing: 'border-box',
            resize: 'vertical',
            fontFamily: 'inherit',
            fontSize: 13,
            border: tooLong ? '1px solid #d0021b' : '1px solid #ccc',
            borderRadius: 4,
            marginBottom: 4,
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: tooLong ? '#d0021b' : '#999',
            }}
          >
            {text.length}/{MAX_CHARS}
          </span>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{ padding: '6px 14px', fontSize: 13 }}
          >
            Send
          </button>
        </div>
        {submitError && (
          <p role="alert" style={{ color: '#c00', fontSize: 12, marginTop: 4 }}>
            {submitError}
          </p>
        )}
      </form>
    </div>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: isMobile ? 'none' : '35 35 0', overflowY: 'auto' }}>
        {metadata}
      </div>
      <div
        style={{
          flex: isMobile ? 'none' : '65 65 0',
          borderLeft: isMobile ? 'none' : '1px solid #e0e0e0',
          borderTop: isMobile ? '1px solid #e0e0e0' : 'none',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {thread}
      </div>
    </div>
  );
};

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <tr>
      <td
        style={{
          color: '#666',
          paddingRight: 12,
          paddingBottom: 4,
          verticalAlign: 'top',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </td>
      <td
        style={{
          paddingBottom: 4,
          fontFamily: mono ? 'monospace' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </td>
    </tr>
  );
}
