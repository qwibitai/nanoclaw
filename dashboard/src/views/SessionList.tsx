import React from 'react';
import useSWR from 'swr';
import { listSessions } from '../lib/api.js';
import type { AuthMe } from '../lib/api.js';

interface SessionListProps {
  authMe: AuthMe;
}

export const SessionList: React.FC<SessionListProps> = ({ authMe: _authMe }) => {
  const { data } = useSWR('/dashboard/api/sessions', () => listSessions());

  const sessions = data?.sessions ?? [];

  if (sessions.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Sessions</h2>
        <p style={{ color: 'var(--text-muted)' }}>No live sessions</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, overflowX: 'auto' }}>
      <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Sessions</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border)' }}>
            <Th>Agent Group ID</Th>
            <Th>Session ID</Th>
            <Th>Last Active</Th>
            <Th>Container Status</Th>
            <Th>Messaging Group ID</Th>
            <Th>Thread</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
              <Td mono>{s.agent_group_id}</Td>
              <Td mono>{s.session_id}</Td>
              <Td>{s.last_active ?? '—'}</Td>
              <Td>{s.container_status}</Td>
              <Td mono>{s.messaging_group_id ?? '—'}</Td>
              <Td mono>{s.thread_id ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', fontSize: 11, letterSpacing: '0.04em' }}>
      {children}
    </th>
  );
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: '6px 10px',
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        fontSize: mono ? 11 : undefined,
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </td>
  );
}
