# Slack Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable NanoClaw's Slack channel to receive images from users (delivered to the agent as multimodal content blocks) and send images back (via a new `send_image` MCP tool), with bidirectional multi-image support.

**Architecture:** Channel-agnostic abstraction. New `ImageAttachment` type carried through `NewMessage` for inbound, and a new optional `Channel.sendImage(jid, paths, caption?)` method for outbound. Inbound: Slack fetches `msg.files[]` → `sharp`-resize → base64 → multimodal content blocks pushed into the Agent SDK's user message. Outbound: agent calls MCP tool `send_image` → IPC file in `/workspace/ipc/images/` → host watcher → `Channel.sendImage` → Slack `files.uploadV2`.

**Tech Stack:** Node.js 20, TypeScript, Vitest, `@slack/bolt` (Socket Mode), `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `sharp` (new), `zod`.

**Spec:** `docs/superpowers/specs/2026-04-16-slack-image-support-design.md`

---

## File Structure

**New files:**
- `src/image.ts` — shared helper: `processImageBuffer()`, `isSupportedImageMime()`.
- `src/image.test.ts` — unit tests for the helper.
- `src/ipc.test.ts` — unit tests for the new image IPC branch (authorization, path validation, file routing).

**Modified files:**
- `src/types.ts` — add `ImageAttachment`, extend `NewMessage`, extend `Channel`.
- `src/channels/slack.ts` — inbound file handling, `sendImage()`, queue type widening.
- `src/channels/slack.test.ts` — new inbound and outbound image tests.
- `src/index.ts` — forward `images` into `ContainerInput`; register `routeOutboundImage` as `IpcDeps.sendImage`.
- `src/router.ts` — add `routeOutboundImage()` alongside `routeOutbound`.
- `src/routing.test.ts` — tests for `routeOutboundImage` (channel lookup + graceful fallback).
- `src/container-runner.ts` — extend `ContainerInput` passthrough.
- `src/ipc.ts` — add `images` dir processing; extend `IpcDeps`.
- `container/agent-runner/src/index.ts` — extend `ContainerInput`, multimodal `MessageStream.push`, wider `drainIpcInput()` shape.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — new `send_image` tool.
- `package.json` / `package-lock.json` — add `sharp`.

---

## Task 0: Add vitest to the agent-runner package

**Rationale:** `container/agent-runner/` currently has no test runner. Tasks 9 and 14 need one. Adding vitest once up front avoids the cascading "if vitest isn't configured, then..." branches.

**Files:**
- Modify: `container/agent-runner/package.json`
- Create: `container/agent-runner/vitest.config.ts`

- [ ] **Step 1: Confirm vitest is not already configured**

Run: `grep -q '"vitest"' container/agent-runner/package.json && echo PRESENT || echo MISSING`
Expected: `MISSING`. (If `PRESENT`, skip this task.)

- [ ] **Step 2: Install vitest**

Run: `cd container/agent-runner && npm install -D vitest`
Expected: vitest added to devDependencies.

- [ ] **Step 3: Add test script**

In `container/agent-runner/package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 4: Add minimal vitest config**

Create `container/agent-runner/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Smoke-test the runner**

Run: `cd container/agent-runner && npm test`
Expected: exits 0 with "No test files found, exiting with code 0" (or similar — 0 tests pass cleanly).

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json container/agent-runner/vitest.config.ts
git commit -m "test(agent-runner): add vitest for container-side unit tests"
```

---

## Task 1: Add `sharp` dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install sharp**

Run: `npm install sharp`
Expected: `sharp` appears in `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Verify install**

Run: `npm ls sharp`
Expected: shows `sharp@X.Y.Z` with no missing-peer warnings.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add sharp for image resize/encode"
```

---

## Task 2: Data model — `ImageAttachment` + `NewMessage.images` + `Channel.sendImage`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add types**

Add to `src/types.ts`:

```ts
export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64, already resized + encoded by the inbound channel
}
```

In `NewMessage` (at `src/types.ts:45`), add:

```ts
  images?: ImageAttachment[];
```

In `Channel` (at `src/types.ts:87`), add:

```ts
  sendImage?(jid: string, imagePaths: string[], caption?: string): Promise<void>;
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: Clean build. No call sites break because both additions are optional.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add ImageAttachment, NewMessage.images, Channel.sendImage"
```

---

## Task 3: Shared image helper — `isSupportedImageMime` (TDD)

**Files:**
- Create: `src/image.ts`
- Create: `src/image.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isSupportedImageMime } from './image.js';

describe('isSupportedImageMime', () => {
  it('accepts image/jpeg', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true);
  });
  it('accepts image/png', () => {
    expect(isSupportedImageMime('image/png')).toBe(true);
  });
  it('accepts image/gif', () => {
    expect(isSupportedImageMime('image/gif')).toBe(true);
  });
  it('accepts image/webp', () => {
    expect(isSupportedImageMime('image/webp')).toBe(true);
  });
  it('rejects image/heic', () => {
    expect(isSupportedImageMime('image/heic')).toBe(false);
  });
  it('rejects application/pdf', () => {
    expect(isSupportedImageMime('application/pdf')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isSupportedImageMime('')).toBe(false);
  });
  it('rejects undefined-shaped input', () => {
    expect(isSupportedImageMime(undefined as unknown as string)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `npx vitest run src/image.test.ts`
Expected: FAIL with "Cannot find module './image.js'".

- [ ] **Step 3: Implement minimal helper**

Create `src/image.ts`:

```ts
const SUPPORTED: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageMime(mime: string | undefined | null): boolean {
  return !!mime && SUPPORTED.has(mime);
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/image.test.ts`
Expected: 8 passed.

---

## Task 4: Shared image helper — `processImageBuffer` (TDD)

**Files:**
- Modify: `src/image.ts`
- Modify: `src/image.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/image.test.ts`:

```ts
import sharp from 'sharp';
import { processImageBuffer, type ImageAttachment } from './image.js';

async function makePngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe('processImageBuffer', () => {
  it('resizes a large image so long edge is at most 1568px', async () => {
    const buf = await makePngBuffer(3000, 2000);
    const att = await processImageBuffer(buf, 'image/png');
    expect(att).not.toBeNull();
    const decoded = Buffer.from(att!.data, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
  });

  it('re-encodes as JPEG (mediaType = image/jpeg) after resize', async () => {
    const buf = await makePngBuffer(3000, 2000);
    const att = await processImageBuffer(buf, 'image/png');
    expect(att!.mediaType).toBe('image/jpeg');
  });

  it('passes through small images without upscaling', async () => {
    const buf = await makePngBuffer(800, 600);
    const att = await processImageBuffer(buf, 'image/png');
    const decoded = Buffer.from(att!.data, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBeLessThanOrEqual(800);
    expect(meta.height).toBeLessThanOrEqual(600);
  });

  it('returns null when buffer cannot be decoded', async () => {
    const bogus = Buffer.from('not-an-image');
    const att = await processImageBuffer(bogus, 'image/png');
    expect(att).toBeNull();
  });

  it('base64 output decodes back to a valid image', async () => {
    const buf = await makePngBuffer(400, 300);
    const att = await processImageBuffer(buf, 'image/png');
    const decoded = Buffer.from(att!.data, 'base64');
    await expect(sharp(decoded).metadata()).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `npx vitest run src/image.test.ts`
Expected: FAIL with "processImageBuffer is not a function".

- [ ] **Step 3: Implement `processImageBuffer`**

Append to `src/image.ts`:

```ts
import sharp from 'sharp';
import { logger } from './logger.js';
import type { ImageAttachment } from './types.js';

export type { ImageAttachment } from './types.js';

const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 85;
const MAX_ENCODED_BYTES = 5 * 1024 * 1024; // Anthropic per-image ceiling

/**
 * Resize (if needed), re-encode as JPEG, base64-encode.
 * Returns null on decode failure or if the result is still too large.
 */
export async function processImageBuffer(
  buffer: Buffer,
  _sourceMime: string,
): Promise<ImageAttachment | null> {
  try {
    const pipeline = sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: MAX_EDGE_PX,
        height: MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY });

    const out = await pipeline.toBuffer();
    if (out.byteLength > MAX_ENCODED_BYTES) {
      logger.warn(
        { bytes: out.byteLength, max: MAX_ENCODED_BYTES },
        'Image exceeds max size after resize, dropping',
      );
      return null;
    }
    return {
      mediaType: 'image/jpeg',
      data: out.toString('base64'),
    };
  } catch (err) {
    logger.warn({ err }, 'processImageBuffer failed');
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/image.test.ts`
Expected: 13 passed (8 from Task 3 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/image.ts src/image.test.ts
git commit -m "feat(image): add shared resize + base64 helper"
```

---

## Task 5: Slack inbound — extend tests first (TDD)

**Files:**
- Modify: `src/channels/slack.test.ts`

- [ ] **Step 1: Add a `files` field to the test event helper**

At `src/channels/slack.test.ts:109`, extend `createMessageEvent` to accept an optional `files` parameter:

```ts
function createMessageEvent(overrides: {
  // ...existing fields...
  files?: Array<{
    id?: string;
    mimetype?: string;
    url_private_download?: string;
    name?: string;
  }>;
}) {
  return {
    // ...existing fields...
    files: overrides.files,
  };
}
```

- [ ] **Step 2: Mock global fetch at top of test file**

Inside the top-level `describe('SlackChannel', ...)` block, before tests:

```ts
const fetchMock = vi.fn();
// Before each test set global fetch
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
```

And ensure `afterEach` restores it:

```ts
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).fetch;
});
```

Also mock `../image.js`:

```ts
vi.mock('../image.js', () => ({
  processImageBuffer: vi.fn(async (_buf: Buffer, mime: string) => ({
    mediaType: 'image/jpeg' as const,
    data: 'ZmFrZS1iYXNlNjQ=',
  })),
  isSupportedImageMime: (m: string) =>
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m),
}));
```

- [ ] **Step 3: Add new `describe('image inbound', ...)` block**

Add near the end of the file, before the closing `});` of the outer describe:

```ts
describe('image inbound', () => {
  function okFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
  }

  it('delivers an images-only message (no text, one image)', async () => {
    okFetch();
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: undefined as any,
        files: [
          {
            id: 'F1',
            mimetype: 'image/png',
            url_private_download: 'https://files.slack.com/F1/download',
            name: 'pic.png',
          },
        ],
      }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content: '',
        images: [{ mediaType: 'image/jpeg', data: 'ZmFrZS1iYXNlNjQ=' }],
      }),
    );
  });

  it('delivers a text+images message with multiple images', async () => {
    okFetch();
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: 'Look at these',
        files: [
          { id: 'F1', mimetype: 'image/png', url_private_download: 'https://u/1', name: 'a.png' },
          { id: 'F2', mimetype: 'image/jpeg', url_private_download: 'https://u/2', name: 'b.jpg' },
        ],
      }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content: 'Look at these',
        images: expect.arrayContaining([
          expect.objectContaining({ mediaType: 'image/jpeg' }),
        ]),
      }),
    );
    const call = (opts.onMessage as any).mock.calls[0][1];
    expect(call.images.length).toBe(2);
  });

  it('skips unsupported mime types but keeps supported ones', async () => {
    okFetch();
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: 'mixed',
        files: [
          { id: 'F1', mimetype: 'image/heic', url_private_download: 'https://u/1' },
          { id: 'F2', mimetype: 'image/png', url_private_download: 'https://u/2' },
        ],
      }),
    );

    const call = (opts.onMessage as any).mock.calls[0][1];
    expect(call.images.length).toBe(1);
  });

  it('continues when an image fetch fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: 'hi',
        files: [
          { id: 'F1', mimetype: 'image/png', url_private_download: 'https://u/1' },
          { id: 'F2', mimetype: 'image/png', url_private_download: 'https://u/2' },
        ],
      }),
    );

    const call = (opts.onMessage as any).mock.calls[0][1];
    expect(call.images.length).toBe(1);
  });

  it('drops messages with no text and no processable images', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: undefined as any,
        files: [
          { id: 'F1', mimetype: 'image/heic', url_private_download: 'https://u/1' },
        ],
      }),
    );

    // Metadata still fires for chat discovery, but onMessage should not.
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('uses bot token as Authorization header for url_private_download', async () => {
    okFetch();
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      createMessageEvent({
        text: 'x',
        files: [{ id: 'F1', mimetype: 'image/png', url_private_download: 'https://u/1' }],
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://u/1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test-token',
        }),
      }),
    );
  });
});
```

- [ ] **Step 4: Run tests — expect failures**

Run: `npx vitest run src/channels/slack.test.ts`
Expected: new image inbound tests FAIL (Slack channel does not read `msg.files` yet). Existing tests still pass.

---

## Task 6: Slack inbound — implement

**Files:**
- Modify: `src/channels/slack.ts`

- [ ] **Step 1: Capture the bot token on the instance**

At top of `src/channels/slack.ts`, add imports:

```ts
import { processImageBuffer, isSupportedImageMime } from '../image.js';
import type { ImageAttachment } from '../types.js';
```

In the `SlackChannel` class, add a private field:

```ts
private botToken: string;
```

In the constructor (around `src/channels/slack.ts:48`), after reading `env`, set:

```ts
this.botToken = botToken;
```

- [ ] **Step 2: Change early-return at `slack.ts:80`**

Replace:

```ts
if (!msg.text) return;
```

With:

```ts
if (!msg.text && !(msg as { files?: unknown[] }).files?.length) return;
```

- [ ] **Step 3: Add image processing before emitting `onMessage`**

Just before the `this.opts.onMessage(jid, {...})` call (around `src/channels/slack.ts:123`), insert:

```ts
const files = (msg as { files?: Array<{ id?: string; mimetype?: string; url_private_download?: string; name?: string }> }).files ?? [];
const images: ImageAttachment[] = [];
for (const file of files) {
  if (!file.mimetype || !isSupportedImageMime(file.mimetype)) {
    if (file.mimetype) {
      logger.debug({ fileId: file.id, mime: file.mimetype }, 'Slack non-image file skipped');
    }
    continue;
  }
  if (!file.url_private_download) continue;
  try {
    const res = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    if (!res.ok) {
      logger.warn({ fileId: file.id, status: res.status }, 'Slack image fetch failed');
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const att = await processImageBuffer(buf, file.mimetype);
    if (att) images.push(att);
  } catch (err) {
    logger.warn({ fileId: file.id, err }, 'Slack image processing error');
  }
}

// If nothing survived (no text AND no images), silently drop to match pre-image behavior.
if (!msg.text && images.length === 0) return;
```

Extend the existing `onMessage` payload to include `images`:

```ts
this.opts.onMessage(jid, {
  id: msg.ts,
  chat_jid: jid,
  sender: msg.user || msg.bot_id || '',
  sender_name: senderName,
  content: content ?? '',
  timestamp,
  is_from_me: isBotMessage,
  is_bot_message: isBotMessage,
  images: images.length ? images : undefined,
});
```

(Note: `content` was previously the translated `msg.text`; ensure the fallback to empty string is there since image-only messages may have no text.)

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/channels/slack.test.ts`
Expected: All existing tests + the 6 new image inbound tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/image.ts src/image.test.ts src/channels/slack.ts src/channels/slack.test.ts src/types.ts
git commit -m "feat(slack): receive image attachments as multimodal content"
```

---

## Task 7: Orchestrator + container-runner passthrough for `images`

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Extend host-side `ContainerInput`**

At `src/container-runner.ts:38`, add to the `ContainerInput` interface:

```ts
  images?: import('./types.js').ImageAttachment[];
```

(Using an inline import to avoid adding a new named import that may cycle; verify no circularity at build time.)

- [ ] **Step 2: Forward `images` in `src/index.ts`**

Locate where the orchestrator builds `ContainerInput` for the container spawn. Find it with:

```bash
grep -n "ContainerInput\|runContainer\|containerInput" src/index.ts
```

In the object construction, add `images: message.images` alongside the existing fields. The value flows through untouched.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts src/index.ts
git commit -m "feat(orchestrator): forward NewMessage.images into ContainerInput"
```

---

## Task 8a: Agent-runner — extract `MessageStream` and add `ImageAttachment` type

**Rationale:** Before widening `MessageStream.push`, pull the class into its own module so it's independently testable. All other agent-runner changes then build on this clean boundary.

**Files:**
- Create: `container/agent-runner/src/message-stream.ts`
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Create `message-stream.ts` with the ImageAttachment type and a text-only `push` (matches current behavior)**

Create `container/agent-runner/src/message-stream.ts`:

```ts
export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | object[] };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageAttachment[]): void {
    const content: string | object[] = images?.length
      ? [
          ...images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
          { type: 'text' as const, text },
        ]
      : text;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}
```

This class already accepts optional `images` — we do both the extraction and the widening in one atomic change, because they're tightly coupled (you cannot widen without a type definition, and the extraction forces you to decide on the signature).

- [ ] **Step 2: Remove the inline `MessageStream` and `SDKUserMessage` from `index.ts`**

In `container/agent-runner/src/index.ts`, delete the `SDKUserMessage` interface at lines 56-61 and the `MessageStream` class at lines 71-103.

Add the import at the top (after the existing imports around line 25):

```ts
import { MessageStream, type ImageAttachment } from './message-stream.js';
```

- [ ] **Step 3: Extend `ContainerInput` with `images`**

At line 27, change the interface to:

```ts
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  images?: ImageAttachment[];
}
```

- [ ] **Step 4: Typecheck**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean. (Call sites of `stream.push(prompt)` still work — the new `images` parameter is optional.)

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/message-stream.ts container/agent-runner/src/index.ts
git commit -m "refactor(agent-runner): extract MessageStream; add ImageAttachment type"
```

---

## Task 8b: Agent-runner — widen `drainIpcInput` return type (non-behavioral)

**Rationale:** Split from 8c because the return-type change touches multiple call sites; doing it without changing runtime behavior first keeps the diff small and reviewable.

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Widen the return type of `drainIpcInput`**

At `container/agent-runner/src/index.ts:311`, replace the function signature and body:

```ts
function drainIpcInput(): Array<{ text: string; images?: ImageAttachment[] }> {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: Array<{ text: string; images?: ImageAttachment[] }> = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            images: Array.isArray(data.images) ? data.images : undefined,
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
```

- [ ] **Step 2: Change `waitForIpcMessage` to return the array (not a joined string)**

At line 350, replace with:

```ts
function waitForIpcMessage(): Promise<Array<{ text: string; images?: ImageAttachment[] }> | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}
```

- [ ] **Step 3: Update the call site in `main()` (around line 729)**

Replace:

```ts
const nextMessage = await waitForIpcMessage();
if (nextMessage === null) {
  log('Close sentinel received, exiting');
  break;
}

log(`Got new message (${nextMessage.length} chars), starting new query`);
prompt = nextMessage;
```

With:

```ts
const nextMessages = await waitForIpcMessage();
if (nextMessages === null) {
  log('Close sentinel received, exiting');
  break;
}

log(`Got ${nextMessages.length} new message(s), starting new query`);
// First message becomes the new turn's prompt + initial images.
prompt = nextMessages[0].text;
initialImages = nextMessages[0].images;
// Remaining messages are queued to be pushed into the stream after runQuery starts.
pendingFollowUps = nextMessages.slice(1);
```

- [ ] **Step 4: Introduce `initialImages` and `pendingFollowUps` state in `main()`**

Near the top of `main()` where `sessionId` is declared (around line 649), add:

```ts
let initialImages: ImageAttachment[] | undefined;
let pendingFollowUps: Array<{ text: string; images?: ImageAttachment[] }> = [];
```

- [ ] **Step 5: Update the initial drain at `main()` around line 664**

Replace:

```ts
const pending = drainIpcInput();
if (pending.length > 0) {
  log(`Draining ${pending.length} pending IPC messages into initial prompt`);
  prompt += '\n' + pending.join('\n');
}
```

With:

```ts
const pending = drainIpcInput();
if (pending.length > 0) {
  log(`Draining ${pending.length} pending IPC messages into initial prompt`);
  prompt += '\n' + pending.map((p) => p.text).join('\n');
  // Collect images from pending messages into initialImages
  const pendingImages = pending.flatMap((p) => p.images ?? []);
  if (pendingImages.length) {
    initialImages = [...(containerInput.images ?? []), ...pendingImages];
  } else {
    initialImages = containerInput.images;
  }
}
```

Also, outside the `if`, set the default (for the no-pending case):

```ts
if (!initialImages) initialImages = containerInput.images;
```

- [ ] **Step 6: Typecheck**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean. (`runQuery` doesn't consume the new state yet — that's Task 8c.)

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "refactor(agent-runner): widen IPC input drain shape for images"
```

---

## Task 8c: Agent-runner — pipe images through `runQuery`

**Rationale:** Now `runQuery` consumes the widened inputs and produces multimodal `stream.push` calls.

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Extend `runQuery` signature**

At `container/agent-runner/src/index.ts:374`, change:

```ts
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{...}>
```

To:

```ts
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  images?: ImageAttachment[],
  followUps?: Array<{ text: string; images?: ImageAttachment[] }>,
): Promise<{...}>
```

- [ ] **Step 2: Use new params in `runQuery`**

Replace `stream.push(prompt);` (at line 387) with:

```ts
stream.push(prompt, images);
for (const m of followUps ?? []) {
  stream.push(m.text, m.images);
}
```

In the `pollIpcDuringQuery` helper (around line 392), replace:

```ts
const messages = drainIpcInput();
for (const text of messages) {
  log(`Piping IPC message into active query (${text.length} chars)`);
  stream.push(text);
}
```

With:

```ts
const messages = drainIpcInput();
for (const m of messages) {
  log(
    `Piping IPC message into active query (${m.text.length} chars, ${m.images?.length ?? 0} images)`,
  );
  stream.push(m.text, m.images);
}
```

- [ ] **Step 3: Pass `initialImages` and `pendingFollowUps` at both `runQuery` call sites**

In `main()`'s query loop (around line 700), change:

```ts
const queryResult = await runQuery(
  prompt,
  sessionId,
  mcpServerPath,
  containerInput,
  sdkEnv,
  resumeAt,
);
```

To:

```ts
const queryResult = await runQuery(
  prompt,
  sessionId,
  mcpServerPath,
  containerInput,
  sdkEnv,
  resumeAt,
  initialImages,
  pendingFollowUps,
);
// After the query consumed them, clear so the next iteration starts fresh:
initialImages = undefined;
pendingFollowUps = [];
```

- [ ] **Step 4: Typecheck**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): deliver images to SDK as multimodal content"
```

---

## Task 9: MCP `send_image` tool (TDD)

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Note:** MCP tool unit tests use vitest added to `container/agent-runner/` in Task 0. Path validation is lifted into an exported pure helper so it's unit-testable; the IPC-writing side is covered end-to-end by the host-side `src/ipc.test.ts` in Task 11.

- [ ] **Step 1: Write the validation helper and failing test**

At the top of `container/agent-runner/src/ipc-mcp-stdio.ts`, after imports, add:

```ts
export function validateImagePath(
  input: string,
  workspaceRoot: string,
  fsImpl: { existsSync: (p: string) => boolean } = fs,
): { ok: true; absolute: string; relative: string } | { ok: false; error: string } {
  const abs = path.resolve(workspaceRoot, input);
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + path.sep)) {
    return { ok: false, error: `Path escapes group workspace: ${input}` };
  }
  if (!fsImpl.existsSync(abs)) {
    return { ok: false, error: `File not found: ${input}` };
  }
  return { ok: true, absolute: abs, relative: path.relative(workspaceRoot, abs) };
}
```

Create `container/agent-runner/src/ipc-mcp-stdio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateImagePath } from './ipc-mcp-stdio.js';

const root = '/workspace/group';

describe('validateImagePath', () => {
  it('accepts a relative path whose file exists', () => {
    const res = validateImagePath('outbox/foo.png', root, {
      existsSync: (p) => p === '/workspace/group/outbox/foo.png',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.absolute).toBe('/workspace/group/outbox/foo.png');
      expect(res.relative).toBe('outbox/foo.png');
    }
  });

  it('rejects a path that resolves outside workspace', () => {
    const res = validateImagePath('../../etc/passwd', root, {
      existsSync: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/escapes/);
  });

  it('rejects an absolute path outside workspace', () => {
    const res = validateImagePath('/tmp/foo.png', root, {
      existsSync: () => true,
    });
    expect(res.ok).toBe(false);
  });

  it('accepts an absolute path inside workspace', () => {
    const res = validateImagePath('/workspace/group/a/b.jpg', root, {
      existsSync: (p) => p === '/workspace/group/a/b.jpg',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a missing file', () => {
    const res = validateImagePath('missing.png', root, {
      existsSync: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd container/agent-runner && npm test -- src/ipc-mcp-stdio.test.ts`
Expected: FAIL with "validateImagePath is not exported" (or similar). Task 0 established vitest, so the runner works.

- [ ] **Step 3: Add the `send_image` tool**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the existing `schedule_task` tool (around line 216), insert:

```ts
const WORKSPACE_ROOT = '/workspace/group';
const IMAGES_DIR = path.join(IPC_DIR, 'images');

server.tool(
  'send_image',
  "Send one or more images to the user or group. Images must be files that already exist inside your group workspace (/workspace/group/**). Pass a single path or an array of up to 10 paths; an array produces a single message with multiple image attachments (album). Paths may be relative to /workspace/group/ or absolute within it. Optional caption appears alongside the image(s). Do not delete the files immediately after calling — delivery may be queued briefly if the channel is reconnecting.",
  {
    path: z
      .union([z.string(), z.array(z.string()).min(1).max(10)])
      .describe(
        'Path(s) to image file(s). Relative paths resolve against /workspace/group/. Absolute paths must be inside /workspace/group/; paths outside are rejected.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption shown with the image(s)'),
  },
  async (args) => {
    const rawPaths = Array.isArray(args.path) ? args.path : [args.path];
    const relatives: string[] = [];
    for (const p of rawPaths) {
      const v = validateImagePath(p, WORKSPACE_ROOT);
      if (!v.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: v.error }],
        };
      }
      relatives.push(v.relative);
    }
    writeIpcFile(IMAGES_DIR, {
      type: 'image',
      chatJid,
      groupFolder,
      paths: relatives,
      caption: args.caption,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `${relatives.length} image(s) queued for delivery.`,
        },
      ],
    };
  },
);
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd container/agent-runner && npm test && cd - && npm run build && npx vitest run`
Expected: Agent-runner tests pass (5 for validateImagePath), host build is clean, host tests all pass.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/ipc-mcp-stdio.test.ts
git commit -m "feat(mcp): add send_image tool for outbound images"
```

---

## Task 10: Host `routeOutboundImage` in `src/router.ts` (TDD)

**Files:**
- Modify: `src/router.ts`
- Modify: `src/routing.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/routing.test.ts`, append:

```ts
import { routeOutboundImage } from './router.js';

describe('routeOutboundImage', () => {
  function makeChannel(
    owns: (j: string) => boolean,
    connected = true,
    withSendImage = true,
  ) {
    return {
      name: 'test',
      ownsJid: owns,
      isConnected: () => connected,
      sendMessage: vi.fn(async () => undefined),
      sendImage: withSendImage ? vi.fn(async () => undefined) : undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
    } as any;
  }

  it('dispatches to channel.sendImage when defined', async () => {
    const ch = makeChannel((j) => j === 'slack:C1');
    await routeOutboundImage([ch], 'slack:C1', ['/abs/a.png'], 'hi');
    expect(ch.sendImage).toHaveBeenCalledWith('slack:C1', ['/abs/a.png'], 'hi');
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when channel lacks sendImage', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundImage([ch], 'wa:123', ['/abs/a.png'], 'caption');
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', 'caption');
  });

  it('falls back with [image] placeholder when no caption and no sendImage', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundImage([ch], 'wa:123', ['/abs/a.png']);
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', '[image]');
  });

  it('throws when no connected channel owns the jid', async () => {
    const ch = makeChannel(() => false);
    await expect(
      routeOutboundImage([ch], 'slack:C1', ['/abs/a.png']),
    ).rejects.toThrow(/No channel/);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `npx vitest run src/routing.test.ts`
Expected: FAIL (routeOutboundImage not exported).

- [ ] **Step 3: Implement**

In `src/router.ts`, after `routeOutbound`, add:

```ts
export async function routeOutboundImage(
  channels: Channel[],
  jid: string,
  imagePaths: string[],
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (channel.sendImage) {
    await channel.sendImage(jid, imagePaths, caption);
    return;
  }
  // Graceful fallback: surface the agent's caption (or a placeholder) as text.
  await channel.sendMessage(jid, caption ?? '[image]');
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/routing.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/routing.test.ts
git commit -m "feat(router): add routeOutboundImage with graceful text fallback"
```

---

## Task 11: Host IPC image processor — extract and test pure function (TDD)

**Rationale:** `ipc-auth.test.ts` tests the exported pure function `processTaskIpc` directly rather than firing up `startIpcWatcher` (the watcher has a module-level `ipcWatcherRunning` latch at `src/ipc.ts:28` that makes re-invocation a no-op — unsuitable for per-`it` tests). We follow the same pattern here: extract `processImageIpcFile` as an exported pure function, test it directly with no timers or watcher state, then have `startIpcWatcher` call it in its per-group loop.

**Files:**
- Modify: `src/ipc.ts`
- Create: `src/ipc.test.ts`

- [ ] **Step 1: Extend `IpcDeps`**

In `src/ipc.ts:13`, add to `IpcDeps`:

```ts
  sendImage: (jid: string, paths: string[], caption?: string) => Promise<void>;
```

- [ ] **Step 2: Add the config import**

Replace the existing `config.js` import at the top of `src/ipc.ts`:

```ts
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
```

With:

```ts
import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
```

- [ ] **Step 3: Write failing tests**

Create `src/ipc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processImageIpcFile } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: '@E',
  added_at: '',
  isMain: true,
};

const SLACK_TEST: RegisteredGroup = {
  name: 'Test',
  folder: 'slack_test',
  trigger: '@E',
  added_at: '',
};

const SLACK_OTHER: RegisteredGroup = {
  name: 'Other',
  folder: 'slack_other',
  trigger: '@E',
  added_at: '',
};

describe('processImageIpcFile', () => {
  let tmpDir: string;
  let groupsDir: string;
  let sendImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-img-'));
    groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'slack_test', 'outbox'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'slack_other', 'outbox'), { recursive: true });
    sendImage = vi.fn(async () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registered() {
    return {
      'slack:C1': SLACK_TEST,
      'slack:Cmain': MAIN_GROUP,
    };
  }

  it('dispatches sendImage for a valid authorized image IPC payload', async () => {
    const imgPath = path.join(groupsDir, 'slack_test', 'outbox', 'a.png');
    fs.writeFileSync(imgPath, 'PNGDATA');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/a.png'],
        caption: 'hello',
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [imgPath], 'hello');
  });

  it('rejects path traversal (../../etc/passwd)', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['../../etc/passwd'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('blocks cross-group sends for non-main groups', async () => {
    const imgPath = path.join(groupsDir, 'slack_other', 'outbox', 'x.png');
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test
        groupFolder: 'slack_other',
        paths: ['outbox/x.png'],
      },
      'slack_other', // source is slack_other
      false, // not main
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('allows main group to send to any jid', async () => {
    const imgPath = path.join(groupsDir, 'slack_main', 'outbox', 'x.png');
    fs.mkdirSync(path.join(groupsDir, 'slack_main', 'outbox'), { recursive: true });
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test
        groupFolder: 'slack_main',
        paths: ['outbox/x.png'],
      },
      'slack_main',
      true, // isMain
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith(
      'slack:C1',
      [imgPath],
      undefined,
    );
  });

  it('skips missing files but delivers surviving ones', async () => {
    const goodPath = path.join(groupsDir, 'slack_test', 'outbox', 'ok.png');
    fs.writeFileSync(goodPath, 'OK');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing.png', 'outbox/ok.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [goodPath], undefined);
  });

  it('does not call sendImage when all paths are missing', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing1.png', 'outbox/missing2.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('ignores payloads with missing required fields', async () => {
    await processImageIpcFile(
      { type: 'image' } as any,
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests — expect failure**

Run: `npx vitest run src/ipc.test.ts`
Expected: FAIL (`processImageIpcFile` not exported).

- [ ] **Step 5: Implement the exported pure function**

In `src/ipc.ts`, after `processTaskIpc` (at the bottom of the file), add:

```ts
export interface ImageIpcPayload {
  type?: string;
  chatJid?: string;
  groupFolder?: string;
  paths?: string[];
  caption?: string;
  timestamp?: string;
}

export async function processImageIpcFile(
  data: ImageIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  groupsRoot: string,
  sendImage: (jid: string, paths: string[], caption?: string) => Promise<void>,
): Promise<void> {
  if (
    data.type !== 'image' ||
    !data.chatJid ||
    !Array.isArray(data.paths) ||
    data.paths.length === 0
  ) {
    return;
  }

  const targetGroup = registeredGroups[data.chatJid];
  if (!(isMain || (targetGroup && targetGroup.folder === sourceGroup))) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC image attempt blocked',
    );
    return;
  }

  const groupRoot = path.join(groupsRoot, sourceGroup);
  const absolute: string[] = [];
  for (const rel of data.paths) {
    const abs = path.resolve(groupRoot, rel);
    if (abs !== groupRoot && !abs.startsWith(groupRoot + path.sep)) {
      logger.warn(
        { rel, sourceGroup },
        'IPC image path escapes group root, skipped',
      );
      continue;
    }
    if (!fs.existsSync(abs)) {
      logger.warn(
        { abs, sourceGroup },
        'IPC image file missing on host, skipped',
      );
      continue;
    }
    absolute.push(abs);
  }

  if (absolute.length) {
    await sendImage(data.chatJid, absolute, data.caption);
    logger.info(
      { chatJid: data.chatJid, count: absolute.length, sourceGroup },
      'IPC image delivered',
    );
  }
}
```

- [ ] **Step 6: Run tests — expect pass**

Run: `npx vitest run src/ipc.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 7: Wire into `startIpcWatcher`**

In the per-group loop at `src/ipc.ts:62`, after the tasks block (around line 147), insert:

```ts
const imagesDir = path.join(ipcBaseDir, sourceGroup, 'images');
try {
  if (fs.existsSync(imagesDir)) {
    const imageFiles = fs
      .readdirSync(imagesDir)
      .filter((f) => f.endsWith('.json'));
    for (const file of imageFiles) {
      const filePath = path.join(imagesDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await processImageIpcFile(
          data,
          sourceGroup,
          isMain,
          registeredGroups,
          GROUPS_DIR,
          deps.sendImage,
        );
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error(
          { file, sourceGroup, err },
          'Error processing IPC image',
        );
        const errorDir = path.join(ipcBaseDir, 'errors');
        fs.mkdirSync(errorDir, { recursive: true });
        fs.renameSync(
          filePath,
          path.join(errorDir, `${sourceGroup}-${file}`),
        );
      }
    }
  }
} catch (err) {
  logger.error({ err, sourceGroup }, 'Error reading IPC images directory');
}
```

- [ ] **Step 8: Typecheck**

Run: `npm run build`
Expected: Clean (except `src/index.ts` which needs `sendImage` wired — Task 12).

- [ ] **Step 9: Commit**

```ts
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(ipc): process and authorize outbound image IPC files"
```

---

## Task 12: Wire `routeOutboundImage` into `IpcDeps` in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Locate the `startIpcWatcher` call**

Run: `grep -n "startIpcWatcher\|sendMessage:" src/index.ts`
Find the `deps` object passed into `startIpcWatcher`.

- [ ] **Step 2: Add `sendImage` alongside `sendMessage`**

In the `deps` literal, add:

```ts
sendImage: (jid, paths, caption) => routeOutboundImage(channels, jid, paths, caption),
```

And add the import at the top:

```ts
import { routeOutbound, routeOutboundImage } from './router.js';
```

(Adjust to match however `routeOutbound` is currently imported.)

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(orchestrator): wire routeOutboundImage into IPC watcher"
```

---

## Task 13: Slack outbound — `sendImage` implementation (TDD)

**Files:**
- Modify: `src/channels/slack.ts`
- Modify: `src/channels/slack.test.ts`

- [ ] **Step 1: Extend the bolt mock to include `files.uploadV2`**

In `src/channels/slack.test.ts`, inside the mock `App` class's `client` literal (around line 41), add:

```ts
files: {
  uploadV2: vi.fn().mockResolvedValue(undefined),
},
```

- [ ] **Step 2: Mock `fs.createReadStream`**

At top of the test file, next to other mocks:

```ts
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createReadStream: vi.fn((p: string) => ({ __path: p })),
  };
});
```

- [ ] **Step 3: Write failing outbound tests**

Append to `src/channels/slack.test.ts`, inside the outer describe:

```ts
describe('sendImage', () => {
  it('uploads a single image via files.uploadV2', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await channel.sendImage!('slack:C0123456789', ['/abs/a.png'], 'hi');

    expect(currentApp().client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C0123456789',
        initial_comment: 'hi',
        file_uploads: [
          expect.objectContaining({ filename: 'a.png' }),
        ],
      }),
    );
  });

  it('uploads multiple images as an album', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    await channel.sendImage!(
      'slack:C0123456789',
      ['/abs/a.png', '/abs/b.jpg'],
      undefined,
    );

    const call = (currentApp().client.files.uploadV2 as any).mock.calls[0][0];
    expect(call.file_uploads.length).toBe(2);
    expect(call.file_uploads[0].filename).toBe('a.png');
    expect(call.file_uploads[1].filename).toBe('b.jpg');
  });

  it('queues when disconnected', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);

    await channel.sendImage!('slack:C0123456789', ['/abs/a.png']);
    expect(currentApp().client.files.uploadV2).not.toHaveBeenCalled();
  });

  it('queues on upload failure', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);
    await channel.connect();

    currentApp().client.files.uploadV2.mockRejectedValueOnce(new Error('boom'));
    await expect(
      channel.sendImage!('slack:C0123456789', ['/abs/a.png']),
    ).resolves.toBeUndefined();
  });

  it('flushes queued images on reconnect', async () => {
    const opts = createTestOpts();
    const channel = new SlackChannel(opts);

    await channel.sendImage!('slack:C0123456789', ['/abs/a.png'], 'caption');
    await channel.connect();

    expect(currentApp().client.files.uploadV2).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests — expect failures**

Run: `npx vitest run src/channels/slack.test.ts`
Expected: new sendImage tests FAIL (method not defined).

- [ ] **Step 5: Widen `outgoingQueue` and add `sendImage`**

In `src/channels/slack.ts`:

Replace the `outgoingQueue` declaration at `slack.ts:37` with:

```ts
private outgoingQueue: Array<
  | { kind: 'text'; jid: string; text: string }
  | {
      kind: 'image';
      jid: string;
      imagePaths: string[];
      caption?: string;
    }
> = [];
```

Update the existing `sendMessage` to push `{ kind: 'text', ... }` into the queue (at lines 163 and 185).

Add `sendImage`:

```ts
async sendImage(
  jid: string,
  imagePaths: string[],
  caption?: string,
): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');
  if (!this.connected) {
    this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
    logger.info(
      { jid, count: imagePaths.length, queueSize: this.outgoingQueue.length },
      'Slack disconnected, image queued',
    );
    return;
  }
  try {
    await this.app.client.files.uploadV2({
      channel_id: channelId,
      initial_comment: caption,
      file_uploads: imagePaths.map((p) => ({
        file: fs.createReadStream(p),
        filename: path.basename(p),
      })),
    });
    logger.info(
      { jid, count: imagePaths.length },
      'Slack image(s) sent',
    );
  } catch (err) {
    this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
    logger.warn(
      { jid, err, queueSize: this.outgoingQueue.length },
      'Failed to send Slack image, queued',
    );
  }
}
```

Add imports at the top of `src/channels/slack.ts`:

```ts
import fs from 'fs';
import path from 'path';
```

Update `flushOutgoingQueue` at `slack.ts:264` to branch on `kind`:

```ts
private async flushOutgoingQueue(): Promise<void> {
  if (this.flushing || this.outgoingQueue.length === 0) return;
  this.flushing = true;
  try {
    logger.info(
      { count: this.outgoingQueue.length },
      'Flushing Slack outgoing queue',
    );
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      const channelId = item.jid.replace(/^slack:/, '');
      if (item.kind === 'text') {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack text sent',
        );
      } else {
        await this.app.client.files.uploadV2({
          channel_id: channelId,
          initial_comment: item.caption,
          file_uploads: item.imagePaths.map((p) => ({
            file: fs.createReadStream(p),
            filename: path.basename(p),
          })),
        });
        logger.info(
          { jid: item.jid, count: item.imagePaths.length },
          'Queued Slack image(s) sent',
        );
      }
    }
  } finally {
    this.flushing = false;
  }
}
```

- [ ] **Step 6: Run tests — expect pass**

Run: `npx vitest run src/channels/slack.test.ts`
Expected: All pass.

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 8: Commit**

```bash
git add src/channels/slack.ts src/channels/slack.test.ts
git commit -m "feat(slack): send images via files.uploadV2 (single + album)"
```

---

## Task 14: `MessageStream.push` content-block shape test

**Rationale:** `MessageStream` was already extracted into `message-stream.ts` in Task 8a, so we only need to add the test file — no code move required here.

**Files:**
- Create: `container/agent-runner/src/message-stream.test.ts`

- [ ] **Step 1: Write the test**

Create `container/agent-runner/src/message-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MessageStream } from './message-stream.js';

describe('MessageStream.push', () => {
  it('produces string content when no images are provided', async () => {
    const s = new MessageStream();
    s.push('hello');
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    expect(msg.message.content).toBe('hello');
  });

  it('produces an array of content blocks when images are provided', async () => {
    const s = new MessageStream();
    s.push('describe this', [
      { mediaType: 'image/jpeg', data: 'AAAA' },
      { mediaType: 'image/png', data: 'BBBB' },
    ]);
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    const content = msg.message.content as Array<{
      type: string;
      source?: { type: string; media_type: string; data: string };
      text?: string;
    }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'BBBB' },
    });
    expect(content[2]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('empty images array is treated as no images (returns string content)', async () => {
    const s = new MessageStream();
    s.push('hello', []);
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    expect(msg.message.content).toBe('hello');
  });
});
```

- [ ] **Step 2: Run tests — expect pass**

Run: `cd container/agent-runner && npm test -- src/message-stream.test.ts`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/message-stream.test.ts
git commit -m "test(agent-runner): cover multimodal MessageStream.push shape"
```

---

## Task 15: Rebuild container and sync agent-runner sources

**Files:**
- No file changes — operational steps.

- [ ] **Step 1: Rebuild the container**

Run: `./container/build.sh`
Expected: Build finishes successfully. If COPY steps appear cached, prune the builder (see `CLAUDE.md` Container Build Cache note) and rerun.

- [ ] **Step 2: Sync agent-runner source into group caches**

Run:

```bash
for dir in data/sessions/*/agent-runner-src/; do
  cp container/agent-runner/src/*.ts "$dir"
done
```

Expected: no errors. This is how the add-image-vision skill keeps running sessions in sync; same pattern applies here.

- [ ] **Step 3: Restart service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Expected: exit code 0.

- [ ] **Step 4: Confirm service is running (not just reloaded)**

Run: `launchctl list | grep nanoclaw`
Expected: a line showing a numeric PID (not `-`) and exit status `0`. A dash PID means launchd loaded the job but it isn't running — check `~/Library/Logs/nanoclaw.*.log` for the crash.

---

## Task 16: Manual end-to-end verification

No code changes — a verification checklist before merging.

- [ ] **Step 1: Verify inbound single image**

Send a single photo to Edna in a registered Slack channel. Confirm in logs:

```bash
tail -100 groups/slack_*/logs/container-*.log
```

Expected: Agent response that references the image content (colors, subject, etc.). No "Slack image fetch failed" or "processImageBuffer failed" warnings.

- [ ] **Step 2: Verify inbound multi-image**

Send 3 photos in one Slack message. Expected: Agent responds referencing all three, or at least more than one, showing that multiple attachments reached the SDK.

- [ ] **Step 3: Verify outbound single image**

Ask Edna: "Create a small test PNG in your outbox and send it to this channel." Expected: file arrives in Slack with the agent's caption.

- [ ] **Step 4: Verify outbound album**

Ask Edna to send 2 or 3 images in one call. Expected: a single Slack message with multiple image attachments (album view).

- [ ] **Step 5: Verify graceful fallback on non-Slack channel**

If you have another channel registered (Telegram, WhatsApp), ask Edna to `send_image` into it. Expected: a text message with the caption arrives; host log shows "channel lacks sendImage, falling back to text" (or similar).

- [ ] **Step 6: Check Slack app scopes**

If inbound fetch fails with 403/401, verify the Slack app has both `files:read` and `files:write` OAuth scopes installed in the workspace. Reinstall the app if scopes were added after initial install.

---

## Rollout Notes

- **Slack scopes:** `files:read` (inbound download) and `files:write` (outbound upload). If the bot token predates these, re-authorize the Slack app.
- **Non-main groups:** IPC watcher only accepts image sends for the non-main group's own jid (authorization mirrors `messages`).
- **Queue persistence:** The `outgoingQueue` is in-memory; restarts drop queued images. Matches current text behavior; out of scope to fix here.
- **File lifecycle:** Neither the MCP tool nor the host watcher deletes the agent's source file after upload. Agent is responsible for cleanup if desired.

---

## Skills Referenced

- @superpowers:test-driven-development — used throughout tasks 3–4, 5–6, 8, 10, 11, 13, 14.
- @superpowers:verification-before-completion — before any task-level claim of "done," run the vitest and `npm run build` commands specified in that task.
- @superpowers:systematic-debugging — if a container rebuild silently ships stale code, see `CLAUDE.md` "Container Build Cache" section.
