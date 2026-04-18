import { describe, it, expect } from 'vitest';
import { renderTaskDetail } from '../mini-app/templates/task-detail.js';
import { renderEmailFull } from '../mini-app/templates/email-full.js';

describe('Mini App templates', () => {
  it('renders task detail HTML', () => {
    const html = renderTaskDetail({
      taskId: 't1',
      title: 'Spamhaus Investigation',
      status: 'active',
      steps: [
        { label: 'Check listing', status: 'done', output: 'CBL confirmed' },
        { label: 'Port scan', status: 'active', output: 'Scanning...' },
        { label: 'Request delisting', status: 'pending', output: null },
      ],
      logs: [
        {
          time: '12:03:41',
          level: 'success',
          text: 'Spamhaus lookup complete',
        },
        { time: '12:03:42', level: 'info', text: 'Starting port scan' },
      ],
      startedAt: new Date().toISOString(),
    });

    expect(html).toContain('Spamhaus Investigation');
    expect(html).toContain('Check listing');
    expect(html).toContain('Port scan');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('renders full email HTML', () => {
    const html = renderEmailFull({
      from: 'Alexandre <alexandre@whoisxmlapi.com>',
      to: 'jonathan@example.com',
      subject: 'AdWords update',
      date: '2026-04-16 5:25 AM PT',
      body: '<p>Hi Jonathan, quick update on AdWords...</p>',
      attachments: [],
    });

    expect(html).toContain('AdWords update');
    expect(html).toContain('Alexandre');
    expect(html).toContain('<!DOCTYPE html>');
  });
});
