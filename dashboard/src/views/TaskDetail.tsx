import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import { getTask, postSteer, retryTask } from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { renderMarkdown } from '../lib/markdown.js';
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
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryAdmittedKey, setRetryAdmittedKey] = useState<string | null>(null);
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

  const handleRetry = async () => {
    if (retrying) return;
    setRetryError(null);
    setRetryAdmittedKey(null);
    setRetrying(true);
    try {
      const res = await retryTask(taskId);
      setRetryAdmittedKey(res.idempotency_key);
      void mutate();
    } catch (err: unknown) {
      const apiErr = err as { status?: number; error?: string; message?: string };
      if (apiErr.status === 409) {
        setRetryError('Task is no longer in a retryable state.');
      } else if (apiErr.status === 410) {
        setRetryError('Original orchestrator session is gone — cannot retry from here.');
      } else {
        setRetryError(apiErr.message ?? 'Retry failed. Please try again.');
      }
    } finally {
      setRetrying(false);
    }
  };

  // Scroll-to-bottom on new messages. On desktop, the thread container is
  // its own scrolling pane (split-pane layout) — scroll the ref. On mobile,
  // the page is one scrolling document and the thread has no inner overflow,
  // so the ref's scrollHeight is the page height; scroll the window instead.
  useEffect(() => {
    if (isMobile) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [data, isMobile]);

  const task = data?.task;
  const transcript = data?.transcript ?? [];

  if (!task) {
    return <div style={{ padding: 16 }}>Loading…</div>;
  }

  const statusColor = (() => {
    switch (task.status) {
      case 'pending':   return 'var(--status-pending)';
      case 'running':   return 'var(--status-running)';
      case 'completed': return 'var(--status-completed)';
      case 'failed':    return 'var(--status-failed)';
      case 'cancelled': return 'var(--status-cancelled)';
      default:          return 'var(--text-secondary)';
    }
  })();

  const metadata = (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Task</h2>
      <table style={{ fontSize: 13, borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          <MetaRow label="ID" value={task.task_id} mono />
          <MetaRow
            label="Status"
            value={
              <span className="pill" style={{ background: 'transparent', color: statusColor, border: `1px solid ${statusColor}` }}>
                {task.status}
              </span>
            }
          />
          <MetaRow label="Session" value={task.parent_session_id} mono />
          <MetaRow label="Admitted" value={task.admitted_at} />
          {task.started_at && <MetaRow label="Started" value={task.started_at} />}
          {task.completed_at && <MetaRow label="Completed" value={task.completed_at} />}
          {task.failed_at && <MetaRow label="Failed" value={task.failed_at} />}
          {task.fail_reason && (
            <MetaRow
              label="Reason"
              value={
                <span style={{ color: 'var(--status-failed)' }}>{task.fail_reason}</span>
              }
            />
          )}
          {task.last_progress_message && (
            <MetaRow label="Last progress" value={task.last_progress_message} />
          )}
        </tbody>
      </table>

      {task.result_summary && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Result</div>
          <div
            className="md"
            style={{ fontSize: 13, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(task.result_summary) }}
          />
        </div>
      )}

      {(task.status === 'failed' || task.status === 'cancelled') && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            {retrying ? 'Re-spawning…' : 'Retry task'}
          </button>
          {retryAdmittedKey && (
            <p style={{ color: 'var(--status-completed)', fontSize: 12, marginTop: 6 }}>
              Re-spawned successfully. New task admitted via dashboard.
            </p>
          )}
          {retryError && (
            <p role="alert" style={{ color: 'var(--status-failed)', fontSize: 12, marginTop: 6 }}>
              {retryError}
            </p>
          )}
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Content</div>
        <div
          className="md"
          style={{ fontSize: 13, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(task.task_content) }}
        />
      </div>
    </div>
  );

  const thread = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Desktop: claim the full pane height so the inner thread scroll
        // works against the split-pane parent. Mobile: shrink to content;
        // the document scrolls.
        height: isMobile ? 'auto' : '100%',
        padding: 16,
      }}
    >
      <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Thread</h2>
      <div
        ref={threadRef}
        style={{
          // Desktop: inner pane scrolls. Mobile: render full-height so the
          // page (body) handles scroll; locking overflow here clipped the
          // last messages and the steer form below the fold.
          flex: 1,
          overflowY: isMobile ? 'visible' : 'auto',
          marginBottom: 12,
        }}
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
              ? 'var(--bg-message-dashboard)'
              : entry.source === 'system'
                ? 'var(--bg-message-system)'
                : 'var(--bg-message-agent)';
          const html = renderMarkdown(text);

          return (
            <div
              key={entry.id}
              style={{
                marginBottom: 8,
                padding: '8px 10px',
                borderRadius: 6,
                background: bg,
                border: '1px solid var(--border)',
                fontSize: 13,
                textAlign: isUserSide ? 'right' : 'left',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                {entry.source} · {entry.direction} · {ts}
              </div>
              <div className="md" style={{ textAlign: 'left' }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        })}
      </div>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          // Mobile: pin the steer form to the bottom of the viewport so a
          // long thread doesn't bury the input. `sticky` keeps it in normal
          // flow (so the thread content above can scroll naturally) but
          // anchors it to the bottom edge as the user scrolls.
          ...(isMobile && {
            position: 'sticky',
            bottom: 0,
            background: 'var(--bg-page)',
            paddingBottom: 12,
            marginTop: 12,
          }),
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_CHARS + 100}
          placeholder="Steer the task… (Cmd+Enter to send)"
          rows={3}
          style={{
            width: '100%',
            padding: 10,
            boxSizing: 'border-box',
            resize: 'vertical',
            fontFamily: 'inherit',
            fontSize: 13,
            border: tooLong ? '1px solid var(--status-failed)' : '1px solid var(--border)',
            borderRadius: 6,
            marginBottom: 6,
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
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
              color: tooLong ? 'var(--status-failed)' : 'var(--text-muted)',
            }}
          >
            {text.length}/{MAX_CHARS}
          </span>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{ padding: '7px 16px', fontSize: 13 }}
          >
            Send
          </button>
        </div>
        {submitError && (
          <p role="alert" style={{ color: 'var(--status-failed)', fontSize: 12, marginTop: 6 }}>
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
        // Desktop: lock to parent so the two panes scroll independently
        // (metadata column on left, thread column on right). Mobile: flow
        // naturally and let the document scroll — the previous lock made
        // the steer form and last messages unreachable below the fold.
        height: isMobile ? 'auto' : '100%',
        overflow: isMobile ? 'visible' : 'hidden',
      }}
    >
      <div
        style={{
          flex: isMobile ? 'none' : '35 35 0',
          overflowY: isMobile ? 'visible' : 'auto',
        }}
      >
        {metadata}
      </div>
      <div
        style={{
          flex: isMobile ? 'none' : '65 65 0',
          borderLeft: isMobile ? 'none' : '1px solid var(--border)',
          borderTop: isMobile ? '1px solid var(--border)' : 'none',
          display: 'flex',
          flexDirection: 'column',
          overflow: isMobile ? 'visible' : 'hidden',
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
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <tr>
      <td
        style={{
          color: 'var(--text-muted)',
          paddingRight: 12,
          paddingBottom: 6,
          verticalAlign: 'top',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </td>
      <td
        style={{
          paddingBottom: 6,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          fontSize: mono ? 12 : undefined,
          wordBreak: 'break-all',
          color: 'var(--text-primary)',
        }}
      >
        {value}
      </td>
    </tr>
  );
}
