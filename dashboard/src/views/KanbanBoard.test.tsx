import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock swr before importing KanbanBoard
vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, mutate }));
  (useSWR as unknown as Record<string, unknown>).__mutate = mutate;
  return { default: useSWR };
});

// Mock lib/sse.ts
vi.mock('../lib/sse.ts', () => {
  const handlers: Map<string, Set<(p: unknown) => void>> = new Map();
  return {
    subscribe: vi.fn((kind: string, handler: (p: unknown) => void) => {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind)!.add(handler);
      return () => handlers.get(kind)?.delete(handler);
    }),
    startSSE: vi.fn(),
    __emitEvent: (kind: string, payload: unknown) => {
      for (const h of handlers.get(kind) ?? []) h(payload);
    },
  };
});

// Mock lib/api.ts
vi.mock('../lib/api.js', () => ({
  listTasks: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
  listSessions: vi.fn(),
  getTask: vi.fn(),
  postSteer: vi.fn(),
}));

import { KanbanBoard } from './KanbanBoard.js';
import useSWR from 'swr';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};

describe('KanbanBoard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('test_KanbanBoard_renders_5_lanes', () => {
    it('renders 5 lane headers when task list is empty', () => {
      vi.mocked(useSWR).mockReturnValue({ data: { tasks: [] }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<KanbanBoard authMe={mockAuthMe} />);
      expect(screen.getByText(/pending/i)).toBeInTheDocument();
      expect(screen.getByText(/running/i)).toBeInTheDocument();
      expect(screen.getByText(/completed/i)).toBeInTheDocument();
      expect(screen.getByText(/failed/i)).toBeInTheDocument();
      expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
    });
  });

  describe('test_KanbanBoard_empty_lanes_visible', () => {
    it('all 5 lanes visible with count 0 for empty status groups', () => {
      const tasks = [{
        task_id: 'spawn-1',
        parent_session_id: 'sess-1',
        task_content: 'do something',
        status: 'running' as const,
        admitted_at: new Date().toISOString(),
      }];
      vi.mocked(useSWR).mockReturnValue({ data: { tasks }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);

      render(<KanbanBoard authMe={mockAuthMe} />);

      const pendingLane = screen.getByText(/^Pending/).parentElement!;
      expect(pendingLane.textContent).toContain('(0)');
      const completedLane = screen.getByText(/^Completed/).parentElement!;
      expect(completedLane.textContent).toContain('(0)');
    });
  });

  describe('test_KanbanBoard_card_click_navigates', () => {
    it('clicking a card sets location.hash to #/task/<id>', async () => {
      const tasks = [{
        task_id: 'spawn-42',
        parent_session_id: 'sess-1',
        task_content: 'do something',
        status: 'running' as const,
        admitted_at: new Date().toISOString(),
      }];
      vi.mocked(useSWR).mockReturnValue({ data: { tasks }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);

      render(<KanbanBoard authMe={mockAuthMe} />);
      const card = screen.getByRole('button');
      await userEvent.click(card);
      expect(location.hash).toBe('#/task/spawn-42');
    });
  });

  describe('test_KanbanBoard_sse_event_invalidates_swr', () => {
    it('task_event SSE fires SWR mutate', async () => {
      const mutate = vi.fn();
      vi.mocked(useSWR).mockReturnValue({ data: { tasks: [] }, mutate } as unknown as ReturnType<typeof useSWR>);

      render(<KanbanBoard authMe={mockAuthMe} />);

      // Get the SSE __emitEvent helper
      const sseModule = await import('../lib/sse.ts');
      const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
      emitEvent('task_event', { kind: 'admit', task_id: 'spawn-new' });

      await waitFor(() => expect(mutate).toHaveBeenCalled());
    });
  });

  describe('test_KanbanBoard_mobile_collapses', () => {
    it('sets flex-direction column on mobile viewport', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 800px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      vi.mocked(useSWR).mockReturnValue({ data: { tasks: [] }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);

      const { container } = render(<KanbanBoard authMe={mockAuthMe} />);
      const board = container.firstChild as HTMLElement;
      expect(board.className).toContain('kanban-mobile');
      vi.unstubAllGlobals();
    });
  });
});
