import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('swr', () => {
  const useSWR = vi.fn();
  return { default: useSWR };
});

vi.mock('../lib/api.js', () => ({
  listSessions: vi.fn(),
}));

import { SessionList } from './SessionList.js';
import useSWR from 'swr';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};

const baseSessions = [
  {
    session_id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'thread-1',
    last_active: '2026-05-01T10:00:00Z',
    container_status: 'running' as const,
  },
  {
    session_id: 'sess-2',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-2',
    thread_id: null,
    last_active: '2026-05-01T09:00:00Z',
    container_status: 'idle' as const,
  },
  {
    session_id: 'sess-3',
    agent_group_id: 'ag-2',
    messaging_group_id: 'mg-3',
    thread_id: 'thread-3',
    last_active: '2026-05-01T08:00:00Z',
    container_status: 'stale' as const,
  },
];

describe('SessionList', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('test_SessionList_renders_table', () => {
    it('renders 3 table rows with correct columns', () => {
      vi.mocked(useSWR).mockReturnValue({ data: { sessions: baseSessions }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<SessionList authMe={mockAuthMe} />);
      const rows = screen.getAllByRole('row');
      // 1 header + 3 data rows
      expect(rows).toHaveLength(4);
      expect(screen.getByText('sess-1')).toBeInTheDocument();
      expect(screen.getByText('sess-2')).toBeInTheDocument();
      expect(screen.getByText('sess-3')).toBeInTheDocument();
      expect(screen.getByText('Agent Group ID')).toBeInTheDocument();
      expect(screen.getByText('Session ID')).toBeInTheDocument();
      expect(screen.getByText('Container Status')).toBeInTheDocument();
    });
  });

  describe('test_SessionList_empty_state', () => {
    it('shows no live sessions message when empty', () => {
      vi.mocked(useSWR).mockReturnValue({ data: { sessions: [] }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<SessionList authMe={mockAuthMe} />);
      expect(screen.getByText(/no live sessions/i)).toBeInTheDocument();
    });
  });

  describe('test_SessionList_member_only_no_admin_scopes', () => {
    it('renders sessions without steer button for member role', () => {
      const memberAuth = {
        user_id: 'u2',
        scopes: { role: 'member', allowed_group_ids: ['ag-1'], no_filter: false },
      };
      const memberSessions = baseSessions.filter((s) => s.agent_group_id === 'ag-1');
      vi.mocked(useSWR).mockReturnValue({ data: { sessions: memberSessions }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<SessionList authMe={memberAuth} />);
      expect(screen.getByText('sess-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /steer/i })).toBeNull();
    });
  });
});
