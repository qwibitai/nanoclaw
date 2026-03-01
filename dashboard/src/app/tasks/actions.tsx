'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function TaskActions({
  taskId,
  status,
}: {
  taskId: string;
  status: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function sendCommand(type: string) {
    setLoading(true);
    try {
      await fetch('/api/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, taskId }),
      });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (status === 'completed') return null;

  return (
    <div className="flex gap-1">
      {status === 'active' && (
        <button
          onClick={() => sendCommand('pause_task')}
          disabled={loading}
          className="px-2 py-0.5 text-xs rounded bg-[var(--bg)] border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
        >
          Pause
        </button>
      )}
      {status === 'paused' && (
        <button
          onClick={() => sendCommand('resume_task')}
          disabled={loading}
          className="px-2 py-0.5 text-xs rounded bg-[var(--bg)] border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
        >
          Resume
        </button>
      )}
      <button
        onClick={() => sendCommand('cancel_task')}
        disabled={loading}
        className="px-2 py-0.5 text-xs rounded bg-[var(--bg)] border border-red-900/50 text-[var(--error)] hover:bg-red-900/20 disabled:opacity-50 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
