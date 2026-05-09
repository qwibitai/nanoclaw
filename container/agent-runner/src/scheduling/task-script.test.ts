import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import type { MessageInRow } from '../db/messages-in.js';
import { applyPreTaskScripts } from './task-script.js';

const NEWS_FETCH_WORKER = resolve(import.meta.dir, '../../../scripts/news-fetch-worker.ts');

function taskMsg(id: string, contentObj: object): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'task',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(contentObj),
  };
}

function plainMsg(id: string, text: string): MessageInRow {
  return {
    ...taskMsg(id, {}),
    kind: 'message',
    content: JSON.stringify({ text }),
  };
}

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'task-script-test-'));
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toUTCString();
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/rss') {
        const body = `<?xml version="1.0"?><rss version="2.0"><channel>
          <item><title>News One</title><link>https://x/1</link><pubDate>${minutesAgo(30)}</pubDate></item>
          <item><title>News Two</title><link>https://x/2</link><pubDate>${minutesAgo(90)}</pubDate></item>
        </channel></rss>`;
        return new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

describe('scheduled-task pipeline (applyPreTaskScripts)', () => {
  it('passes non-task messages and task messages without a script through unchanged', async () => {
    const messages: MessageInRow[] = [
      plainMsg('m1', 'hello'),
      taskMsg('t1', { prompt: 'do the thing' }), // no script field
    ];

    const { keep, skipped } = await applyPreTaskScripts(messages);

    expect(skipped).toEqual([]);
    expect(keep).toHaveLength(2);
    expect(keep[0]).toEqual(messages[0]);
    expect(keep[1]).toEqual(messages[1]);
  });

  it('runs the script and injects scriptOutput when wakeAgent is true', async () => {
    const script = `echo "some chatter"\necho '${JSON.stringify({ wakeAgent: true, data: { hello: 'world', n: 7 } })}'`;
    const msg = taskMsg('t-ok', { prompt: 'briefing', script });

    const { keep, skipped } = await applyPreTaskScripts([msg]);

    expect(skipped).toEqual([]);
    expect(keep).toHaveLength(1);
    const enriched = JSON.parse(keep[0].content);
    expect(enriched.prompt).toBe('briefing');
    expect(enriched.script).toBe(script);
    expect(enriched.scriptOutput).toEqual({ hello: 'world', n: 7 });
  });

  it('skips the task when the script signals wakeAgent=false, errors, or returns garbage', async () => {
    const sleep = taskMsg('t-quiet', {
      prompt: 'p',
      script: `echo '${JSON.stringify({ wakeAgent: false, data: { reason: 'nothing new' } })}'`,
    });
    const errored = taskMsg('t-err', {
      prompt: 'p',
      script: `echo "boom" >&2\nexit 1`,
    });
    const garbage = taskMsg('t-junk', {
      prompt: 'p',
      script: `echo "this is not json"`,
    });
    const empty = taskMsg('t-empty', {
      prompt: 'p',
      script: `:`, // bash no-op, no stdout
    });

    const { keep, skipped } = await applyPreTaskScripts([sleep, errored, garbage, empty]);

    expect(keep).toEqual([]);
    expect(new Set(skipped)).toEqual(new Set(['t-quiet', 't-err', 't-junk', 't-empty']));
  });

  it('end-to-end: a task running the news-fetch worker gets parsed feed items in scriptOutput', async () => {
    const configPath = join(tmp, 'news.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        sources: [{ url: `${baseUrl}/rss`, label: 'Test' }],
        windowHours: 24,
        maxItemsPerSource: 10,
        totalBudget: 30000,
      }),
    );

    const script = `NEWS_SOURCES_PATH=${configPath} bun ${NEWS_FETCH_WORKER}`;
    const msg = taskMsg('t-news', { prompt: 'daily news briefing', script });

    const { keep, skipped } = await applyPreTaskScripts([msg]);

    expect(skipped).toEqual([]);
    expect(keep).toHaveLength(1);
    const content = JSON.parse(keep[0].content);
    expect(content.scriptOutput).toBeDefined();
    expect(content.scriptOutput.windowHours).toBe(24);
    expect(content.scriptOutput.sources).toHaveLength(1);
    const src = content.scriptOutput.sources[0];
    expect(src.label).toBe('Test');
    expect(src.items.map((i: { title: string }) => i.title).sort()).toEqual([
      'News One',
      'News Two',
    ]);
  });
});
