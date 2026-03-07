import { describe, expect, it, vi } from 'vitest';

import {
  buildRecallBlock,
  extractEpisodeAtBoundary,
  extractQueryTerms,
  injectRecallBlock,
} from './hippocampus.js';
import { NewMessage } from './types.js';

function msg(
  content: string,
  ts: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: `${ts}-${content.slice(0, 6)}`,
    chat_jid: 'chat-1',
    sender: 'user-1',
    sender_name: 'User',
    content,
    timestamp: ts,
    ...overrides,
  };
}

describe('hippocampus middleware', () => {
  it('extracts query terms from user messages only', () => {
    const query = extractQueryTerms([
      msg('obsoletezz token should be ignored', '2026-03-06T10:00:00.000Z'),
      msg('We discussed postgres alerts yesterday', '2026-03-06T10:01:00.000Z'),
      msg('assistant replay should be ignored', '2026-03-06T10:01:30.000Z', {
        is_from_me: true,
        sender_name: 'Hal',
      }),
      msg('Billing cron failed overnight', '2026-03-06T10:02:00.000Z'),
      msg('Need follow-up for incident timeline', '2026-03-06T10:03:00.000Z'),
      msg(
        'Can you summarize postgres billing outage fixes?',
        '2026-03-06T10:04:00.000Z',
      ),
    ]);

    expect(query).toContain('postgres');
    expect(query).toContain('billing');
    expect(query).not.toContain('obsoletezz');
  });

  it('builds a recall block within budget', () => {
    const block = buildRecallBlock(
      'postgres billing outage',
      [
        {
          text: 'x'.repeat(300),
          score: 0.99,
          source: 'memory/daily-note.md',
          from: 12,
          to: 18,
        },
      ],
      256,
    );

    expect(block).toContain('## RECALL.md');
    expect(block).toContain('Source: memory/daily-note.md:12-18');
    expect(block.length).toBeLessThanOrEqual(1024);
  });

  it('injects recall block into prompt when API returns memories', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async (_input, init) =>
        new Response(
          JSON.stringify({
            results: [
              {
                text: 'Yesterday you fixed postgres vacuum settings for billing jobs.',
                score: 0.92,
                source: 'memory/incidents.md',
                from: 21,
                to: 28,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    const prompt =
      '<messages><message>Current user prompt</message></messages>';
    const output = await injectRecallBlock(
      {
        prompt,
        messages: [
          msg(
            'Any update on postgres billing issue from yesterday?',
            '2026-03-06T10:05:00.000Z',
          ),
        ],
        chatJid: 'chat-1',
        groupFolder: 'main',
      },
      fetchMock,
    );

    const [calledUrl, calledInit] = vi.mocked(fetchMock).mock.calls[0];
    const payload = JSON.parse((calledInit?.body as string) || '{}');

    expect(String(calledUrl)).toContain('/api/recall');
    expect(payload).toMatchObject({
      query: expect.any(String),
      topK: expect.any(Number),
      minScore: expect.any(Number),
    });
    expect(output).toContain('## RECALL.md');
    expect(output).toContain('postgres vacuum settings');
    expect(output).toContain('Source: memory/incidents.md:21-28');
    expect(output).toContain(prompt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches recall results per turn key', async () => {
    const fetchMock: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: [{ text: 'Cached recall value', source: 'memory/cache.md' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;

    const args = {
      prompt: '<messages>hello</messages>',
      messages: [msg('please reuse cached recall', '2026-03-06T10:06:00.000Z')],
      chatJid: 'chat-1',
      groupFolder: 'main',
    };

    const first = await injectRecallBlock(args, fetchMock);
    const second = await injectRecallBlock(args, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toContain('Cached recall value');
    expect(second).toContain('Cached recall value');
  });

  it('gracefully degrades when recall API is down', async () => {
    const fetchMock: typeof fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const prompt = '<messages>no recall</messages>';
    const output = await injectRecallBlock(
      {
        prompt,
        messages: [
          msg(
            'network failure should not break turn',
            '2026-03-06T10:07:00.000Z',
          ),
        ],
        chatJid: 'chat-1',
        groupFolder: 'main',
      },
      fetchMock,
    );

    expect(output).toBe(prompt);
  });

  it('calls episode extraction without throwing on failures', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      extractEpisodeAtBoundary(
        {
          chatJid: 'chat-1',
          groupFolder: 'main',
          boundary: 'session_end',
          messages: [msg('session wrap-up', '2026-03-06T10:08:00.000Z')],
        },
        fetchMock,
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, init] = vi.mocked(fetchMock).mock.calls[0];
    const body = JSON.parse((init?.body as string) || '{}');
    expect(body.boundary).toBe('session_end');
  });
});
