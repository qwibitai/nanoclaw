import { describe, it, expect } from 'vitest';
import { renderTaskDetail } from '../mini-app/templates/task-detail.js';

describe('Mini App SSE', () => {
  it('task detail template includes SSE EventSource script', () => {
    const html = renderTaskDetail({
      taskId: 't1',
      title: 'Test Task',
      status: 'active',
      steps: [],
      logs: [],
      startedAt: new Date().toISOString(),
    });

    expect(html).toContain('EventSource');
    expect(html).toContain('/api/task/');
    expect(html).toContain('stream');
  });

  it('task detail template has data-updated-at attribute', () => {
    const html = renderTaskDetail({
      taskId: 't1',
      title: 'Test Task',
      status: 'active',
      steps: [],
      logs: [],
      startedAt: '2026-04-16T12:00:00Z',
    });

    expect(html).toContain('data-updated-at');
    expect(html).toContain('2026-04-16T12:00:00Z');
  });

  it('task detail template escapes taskId in EventSource script', () => {
    const html = renderTaskDetail({
      taskId: 'task-with-special-<chars>',
      title: 'Test Task',
      status: 'active',
      steps: [],
      logs: [],
      startedAt: '2026-04-16T12:00:00Z',
    });

    // Should not contain raw < or > in the taskId context
    expect(html).not.toContain("'task-with-special-<chars>'");
    expect(html).toContain('EventSource');
  });
});
