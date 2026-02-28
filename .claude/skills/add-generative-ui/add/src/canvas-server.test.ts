import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CanvasServer } from './canvas-server.js';
import { CanvasStore } from './canvas-store.js';
import { RegisteredGroup } from './types.js';

const describeSocket =
  process.env.NANOCLAW_SOCKET_TESTS === '1' ? describe : describe.skip;

let canvasDir: string;
let uiDir: string;
let server: CanvasServer;

beforeEach(async () => {
  canvasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-canvas-state-'));
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-canvas-ui-'));

  fs.writeFileSync(
    path.join(uiDir, 'index.html'),
    '<html><body>canvas</body></html>',
  );
  fs.writeFileSync(path.join(uiDir, 'canvas-app.js'), 'console.log("ok");');
  fs.writeFileSync(path.join(uiDir, 'canvas-app.css'), 'body{}');

  const groups: Record<string, RegisteredGroup> = {
    'main@g.us': {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  };

  server = new CanvasServer({
    canvasStore: new CanvasStore(canvasDir),
    registeredGroups: () => groups,
    port: 0,
    uiDir,
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

function endpoint(pathname: string): string {
  const port = server.getPort();
  if (!port) throw new Error('Server did not expose a port');
  return `http://127.0.0.1:${port}${pathname}`;
}

describeSocket('CanvasServer', () => {
  it('serves canvas shell', async () => {
    const response = await fetch(endpoint('/canvas'));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('canvas');
  });

  it('returns registered groups', async () => {
    const response = await fetch(endpoint('/api/canvas/groups'));
    const payload = (await response.json()) as {
      groups: Array<{ folder: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0].folder).toBe('main');
  });

  it('applies posted SpecStream JSONL and returns updated state', async () => {
    const post = await fetch(endpoint('/api/canvas/main/events'), {
      method: 'POST',
      body: [
        '{"op":"replace","path":"/root","value":"page"}',
        '{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero"]}}',
        '{"op":"add","path":"/elements/hero","value":{"component":"Heading","props":{"text":"Updated"}}}',
      ].join('\n'),
    });

    const updated = (await post.json()) as {
      revision: number;
      spec: {
        root: string;
        elements: {
          hero: { props: { text: string } };
        };
      };
    };
    expect(post.status).toBe(200);
    expect(updated.revision).toBe(3);
    expect(updated.spec.root).toBe('page');
    expect(updated.spec.elements.hero.props.text).toBe('Updated');

    const getState = await fetch(endpoint('/api/canvas/main/state'));
    const state = (await getState.json()) as {
      revision: number;
      spec: {
        root: string;
        elements: {
          hero: { props: { text: string } };
        };
      };
    };

    expect(getState.status).toBe(200);
    expect(state.revision).toBe(3);
    expect(state.spec.root).toBe('page');
    expect(state.spec.elements.hero.props.text).toBe('Updated');
  });

  it('rejects malformed JSONL payloads', async () => {
    const response = await fetch(endpoint('/api/canvas/main/events'), {
      method: 'POST',
      body: 'not-json\n',
    });

    const payload = (await response.json()) as { line: number; error: string };
    expect(response.status).toBe(400);
    expect(payload.line).toBe(1);
    expect(payload.error).toContain('Invalid JSON');
  });
});
