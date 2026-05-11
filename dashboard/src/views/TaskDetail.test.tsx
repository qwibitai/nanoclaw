import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('swr', () => {
  const useSWR = vi.fn();
  return { default: useSWR };
});

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

vi.mock('../lib/api.js', () => ({
  getTask: vi.fn(),
  postSteer: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
  listTasks: vi.fn(),
  listSessions: vi.fn(),
}));

import { TaskDetail } from './TaskDetail.js';
import useSWR from 'swr';
import { postSteer } from '../lib/api.js';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};

const baseTask = {
  task_id: 'spawn-99',
  parent_session_id: 'sess-1',
  task_content: 'Do something important',
  status: 'running' as const,
  admitted_at: '2026-05-01T10:00:00Z',
  started_at: '2026-05-01T10:00:01Z',
};

// Backend-shape transcript (post-build QA fix MF-4): {id, seq, kind, timestamp,
// content, direction, source}. Render extracts text from content.text.
const baseTranscript: Array<{
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  content: { text: string };
  direction: 'inbound' | 'outbound';
  source: 'dashboard' | 'chat' | 'agent' | 'system';
}> = [];

function makeTaskWithTranscript() {
  return {
    task: { ...baseTask },
    transcript: [
      { id: 'msg-1', seq: 1, kind: 'chat', timestamp: '2026-05-01T10:00:00Z', content: { text: 'hi' }, direction: 'inbound' as const, source: 'dashboard' as const },
      { id: 'msg-2', seq: 2, kind: 'chat', timestamp: '2026-05-01T10:00:01Z', content: { text: 'hello' }, direction: 'outbound' as const, source: 'agent' as const },
      { id: 'msg-3', seq: 3, kind: 'chat', timestamp: '2026-05-01T10:00:02Z', content: { text: 'go' }, direction: 'inbound' as const, source: 'dashboard' as const },
    ],
  };
}

describe('TaskDetail', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('test_TaskDetail_renders_lifecycle_and_thread', () => {
    it('shows task metadata and transcript entries', () => {
      const { task, transcript } = makeTaskWithTranscript();
      vi.mocked(useSWR).mockReturnValue({ data: { task, transcript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      expect(screen.getByText('spawn-99')).toBeInTheDocument();
      expect(screen.getByText('hi')).toBeInTheDocument();
      expect(screen.getByText('hello')).toBeInTheDocument();
      expect(screen.getByText('go')).toBeInTheDocument();
    });
  });

  describe('test_TaskDetail_steer_composer_submits_with_uuid', () => {
    it('submits steer with a UUIDv4 idempotency_key', async () => {
      const mutate = vi.fn();
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate } as unknown as ReturnType<typeof useSWR>);
      vi.mocked(postSteer).mockResolvedValue({ task_id: 'spawn-99', message_id: 'msg-1', echo_status: 'pending' });

      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hello');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => expect(postSteer).toHaveBeenCalledOnce());
      const [tid, body] = vi.mocked(postSteer).mock.calls[0] as [string, { idempotency_key: string; text: string }];
      expect(tid).toBe('spawn-99');
      expect(body.text).toBe('hello');
      expect(body.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('test_TaskDetail_empty_text_disables_submit', () => {
    it('submit button is disabled when textarea is empty', () => {
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });
  });

  describe('test_TaskDetail_too_long_disables_submit', () => {
    it('submit disabled and char counter red when text exceeds 4000', () => {
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      const textarea = screen.getByPlaceholderText(/steer/i);
      // Use fireEvent to set the value instantly (avoids userEvent char-by-char 4001ms overhead)
      fireEvent.change(textarea, { target: { value: 'a'.repeat(4001) } });
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
      const counter = screen.getByText(/4001\/4000/);
      expect(counter).toBeInTheDocument();
    });
  });

  describe('test_TaskDetail_rate_limited_shows_retry_after', () => {
    it('shows rate limit message with retry-after seconds', async () => {
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      vi.mocked(postSteer).mockRejectedValue({ status: 429, error: 'rate_limit_exceeded', retry_after: 5 });

      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hi');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/rate limited.*5s/i);
      });
    });
  });

  describe('test_TaskDetail_mismatched_payload_resets', () => {
    it('shows conflict message and generates new UUID on next submit', async () => {
      const mutate = vi.fn();
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate } as unknown as ReturnType<typeof useSWR>);
      vi.mocked(postSteer)
        .mockRejectedValueOnce({ status: 422, error: 'mismatched_idempotency_payload' })
        .mockResolvedValueOnce({ task_id: 'spawn-99', message_id: 'msg-2', echo_status: 'pending' });

      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);

      await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hi');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/idempotency conflict/i);
      });

      // Textarea should be cleared; type again and submit
      await userEvent.type(screen.getByPlaceholderText(/steer/i), 'retry');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => expect(postSteer).toHaveBeenCalledTimes(2));

      const key1 = (vi.mocked(postSteer).mock.calls[0] as [string, { idempotency_key: string }])[1].idempotency_key;
      const key2 = (vi.mocked(postSteer).mock.calls[1] as [string, { idempotency_key: string }])[1].idempotency_key;
      expect(key1).not.toBe(key2);
    });
  });

  describe('test_TaskDetail_inbound_message_sse_invalidates', () => {
    it('inbound_message SSE fires mutate', async () => {
      const mutate = vi.fn();
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate } as unknown as ReturnType<typeof useSWR>);

      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);

      const sseModule = await import('../lib/sse.ts');
      const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
      emitEvent('inbound_message', { task_id: 'spawn-99' });

      await waitFor(() => expect(mutate).toHaveBeenCalled());
    });
  });

  describe('test_TaskDetail_no_edit_or_undo', () => {
    it('rendered messages have no Edit/Delete/Undo controls', () => {
      const { task, transcript } = makeTaskWithTranscript();
      vi.mocked(useSWR).mockReturnValue({ data: { task, transcript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    });
  });

  describe('test_TaskDetail_mobile_collapse', () => {
    it('stacks metadata before thread on mobile viewport', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 800px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      vi.mocked(useSWR).mockReturnValue({ data: { task: baseTask, transcript: baseTranscript }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>);
      const { container } = render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99" />);
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.style.flexDirection).toBe('column');
    });
  });
});
