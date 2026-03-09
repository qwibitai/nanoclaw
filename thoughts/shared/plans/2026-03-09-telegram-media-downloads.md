# Telegram Media File Downloads — Implementation Plan

## Overview

Download media files sent via Telegram (photos, videos, voice messages, audio, documents, stickers) and save them to the group workspace folder so the agent can access the actual content. Replace placeholder strings like `[Photo]` with paths like `[Photo saved: media/photo_42.jpg]`.

## Current State Analysis

The `storeNonText` helper (`src/channels/telegram.ts:128-152`) handles all non-text message types synchronously. It builds a placeholder string (e.g. `[Photo]`), appends any caption, and calls `onMessage`. No bytes are ever downloaded.

### Key Discoveries:
- Grammy's `bot.api.getFile(fileId)` returns `{ file_path, file_size }` — then fetch `https://api.telegram.org/file/bot<TOKEN>/<file_path>` for the bytes
- Photos are arrays — use `ctx.message.photo[photos.length - 1]` (largest resolution) for the `file_id`
- Other types expose `file_id` directly: `ctx.message.video.file_id`, `ctx.message.voice.file_id`, etc.
- Telegram Bot API enforces a **20MB file size limit** — `file_size` is available before downloading
- Group folders mount at `/workspace/group/` in containers, so `groups/<folder>/media/` → `/workspace/group/media/`
- Existing WhatsApp skills use `attachments/` as the subdirectory; this ticket specifies `media/`

### File ID access per media type:
| Type | file_id location | Extension strategy |
|------|------------------|--------------------|
| photo | `ctx.message.photo[last].file_id` | `.jpg` (Telegram always serves JPEG) |
| video | `ctx.message.video.file_id` | from `mime_type` or `.mp4` |
| voice | `ctx.message.voice.file_id` | `.ogg` (Telegram voice = opus in ogg) |
| audio | `ctx.message.audio.file_id` | from `mime_type` or `.mp3` |
| document | `ctx.message.document.file_id` | from `file_name` or `.bin` |
| sticker | `ctx.message.sticker.file_id` | `.webp` |

## Desired End State

- Every downloadable media message saves the file to `groups/<folder>/media/`
- Message content becomes `[Photo saved: media/photo_42.jpg] optional caption`
- Files over 20MB keep the old placeholder with a note: `[Photo — file too large to download] caption`
- Location and Contact remain as placeholders (no file to download)
- All existing tests pass; new tests cover download success, failure, and size-limit paths

## What We're NOT Doing

- Multimodal/vision processing (sending images to Claude as content blocks)
- Transcription of voice/audio messages
- Thumbnail generation
- File deduplication
- Downloading location/contact (no binary content)

## Implementation Approach

Keep all changes within `src/channels/telegram.ts`. Add a private `downloadMedia` method to `TelegramChannel` that handles the getFile → fetch → save flow. Convert `storeNonText` to async and have each media handler extract the `file_id` and desired extension, then call the download method. On failure or size limit, fall back to the original placeholder.

---

## Phase 1: Add `downloadMedia` helper method

### Overview
Add a private method to `TelegramChannel` that downloads a file by `file_id` and saves it to the group's `media/` directory.

### Changes Required:

#### 1. Add import for `fs`, `path`, and `GROUPS_DIR`
**File**: `src/channels/telegram.ts`
**Changes**: Add imports at top

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
```

#### 2. Add `downloadMedia` private method
**File**: `src/channels/telegram.ts`
**Changes**: Add method to `TelegramChannel` class (after `setTyping`, before the closing brace)

```typescript
/**
 * Download a Telegram file and save it to the group's media/ directory.
 * Returns the relative path (e.g. "media/photo_42.jpg") on success, or null on failure.
 */
private async downloadMedia(
  groupFolder: string,
  fileId: string,
  prefix: string,
  extension: string,
  messageId: string,
): Promise<string | null> {
  if (!this.bot) return null;

  try {
    const file = await this.bot.api.getFile(fileId);

    // Check 20MB limit (file_size may be undefined for some types)
    if (file.file_size && file.file_size > 20 * 1024 * 1024) {
      logger.warn({ fileId, size: file.file_size }, 'Telegram file exceeds 20MB limit');
      return null;
    }

    if (!file.file_path) {
      logger.warn({ fileId }, 'Telegram getFile returned no file_path');
      return null;
    }

    // SECURITY: This URL contains the bot token — never log it
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ fileId, status: response.status }, 'Telegram file download failed');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
    await fs.mkdir(mediaDir, { recursive: true });

    const filename = `${prefix}_${messageId}${extension}`;
    const filePath = path.join(mediaDir, filename);
    await fs.writeFile(filePath, buffer);

    logger.info({ fileId, filePath }, 'Telegram media file saved');
    return `media/${filename}`;
  } catch (err) {
    logger.warn({ fileId, err }, 'Failed to download Telegram media');
    return null;
  }
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors (`npm run build`)
- [x] Existing tests still pass (`npm test`)

**Implementation Note**: After completing this phase and verifying compilation, proceed to Phase 2.

---

## Phase 2: Wire download into media handlers

### Overview
Convert `storeNonText` to an async function that accepts download parameters. Update each media handler to extract the `file_id` and call the download. Fall back to the original placeholder on failure.

### Changes Required:

#### 1. Rewrite `storeNonText` to support downloads
**File**: `src/channels/telegram.ts`
**Changes**: Replace the existing `storeNonText` function and media handler registrations (lines 128-169)

```typescript
// Handle non-text messages — download media when possible.
// Grammy awaits the promise returned by event handlers, so all handlers
// must return the promise from storeNonText (use expression body, not block body).
const storeNonText = async (
  ctx: any,
  placeholder: string,
  download?: { fileId: string; label: string; prefix: string; extension: string },
) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name ||
    ctx.from?.username ||
    ctx.from?.id?.toString() ||
    'Unknown';
  const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
  const messageId = ctx.message.message_id.toString();

  let content: string;
  if (download) {
    const savedPath = await this.downloadMedia(
      group.folder,
      download.fileId,
      download.prefix,
      download.extension,
      messageId,
    );
    if (savedPath) {
      // e.g. "[Photo saved: media/photo_42.jpg] Look at this"
      content = `[${download.label} saved: ${savedPath}]${caption}`;
    } else {
      content = `${placeholder}${caption}`;
    }
  } else {
    content = `${placeholder}${caption}`;
  }

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
  this.opts.onMessage(chatJid, {
    id: messageId,
    chat_jid: chatJid,
    sender: ctx.from?.id?.toString() || '',
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
  });
};

// IMPORTANT: All handlers use expression body (no braces) so the promise
// returned by storeNonText is passed back to Grammy for proper error handling.
this.bot.on('message:photo', (ctx) => {
  const photos = ctx.message.photo!;
  const largest = photos[photos.length - 1];
  return storeNonText(ctx, '[Photo]', {
    fileId: largest.file_id,
    label: 'Photo',
    prefix: 'photo',
    extension: '.jpg',
  });
});

this.bot.on('message:video', (ctx) =>
  storeNonText(ctx, '[Video]', {
    fileId: ctx.message.video!.file_id,
    label: 'Video',
    prefix: 'video',
    extension: '.mp4',
  })
);

this.bot.on('message:voice', (ctx) =>
  storeNonText(ctx, '[Voice message]', {
    fileId: ctx.message.voice!.file_id,
    label: 'Voice message',
    prefix: 'voice',
    extension: '.ogg',
  })
);

this.bot.on('message:audio', (ctx) =>
  storeNonText(ctx, '[Audio]', {
    fileId: ctx.message.audio!.file_id,
    label: 'Audio',
    prefix: 'audio',
    extension: '.mp3',
  })
);

this.bot.on('message:document', (ctx) => {
  const doc = ctx.message.document!;
  // Sanitize user-provided filename: strip path components and control characters
  const name = path.basename(doc.file_name || 'file').replace(/[\x00-\x1f]/g, '');
  const ext = path.extname(name) || '.bin';
  return storeNonText(ctx, `[Document: ${name}]`, {
    fileId: doc.file_id,
    label: 'Document',
    prefix: 'document',
    extension: ext,
  });
});

this.bot.on('message:sticker', (ctx) => {
  const sticker = ctx.message.sticker!;
  const emoji = sticker.emoji || '';
  return storeNonText(ctx, `[Sticker ${emoji}]`, {
    fileId: sticker.file_id,
    label: 'Sticker',
    prefix: 'sticker',
    extension: '.webp',
  });
});

// Location and contact have no downloadable file
this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));
```

### Key Design Decisions:
- **`download` is optional** — location/contact pass no download params, keeping the old placeholder-only path
- **Graceful fallback** — if download returns null (failure or size limit), the original placeholder is used, so the agent still knows *something* was sent
- **Message ID for filenames** — `photo_42.jpg` is unique per chat and deterministic (no random suffix needed)
- **Extension from `path.extname` for documents** — preserves the original file extension; falls back to `.bin`
- **Separate `label` and `prefix`** — `label` is human-readable display text (e.g. "Voice message"), `prefix` is the filename component (e.g. "voice"). Prevents display bugs like "Voice_message saved:"
- **Handlers return the promise** — Grammy awaits returned promises for error handling. Expression body `(ctx) => storeNonText(...)` or explicit `return` in block body ensures the promise is not silently discarded
- **Filename sanitization** — `doc.file_name` is user-provided; `path.basename()` strips path traversal, `.replace()` strips control characters
- **Async FS operations** — `fs.promises.mkdir` / `fs.promises.writeFile` avoid blocking the event loop during file writes

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors
- [x] Existing tests still pass (some media content assertions will change — update in Phase 3)

**Implementation Note**: Existing tests may fail because content strings changed. That's expected — Phase 3 updates the tests.

---

## Phase 3: Update tests

### Overview
Update the Grammy mock to support `getFile` API calls and `fetch`. Add tests for successful downloads, download failures, and the 20MB size limit.

### Changes Required:

#### 1. Extend Grammy mock with `getFile`
**File**: `src/channels/telegram.test.ts`
**Changes**: Add `getFile` to the mock `api` object

```typescript
api = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
  getFile: vi.fn().mockResolvedValue({
    file_id: 'test-file-id',
    file_path: 'photos/file_0.jpg',
    file_size: 1024,
  }),
};
```

#### 2. Add `fs` and `path` mocks
**File**: `src/channels/telegram.test.ts`
**Changes**: Mock `node:fs` and config's `GROUPS_DIR`

```typescript
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Update config mock to include GROUPS_DIR
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
}));
```

#### 3. Mock global `fetch`
**File**: `src/channels/telegram.test.ts`

```typescript
// In beforeEach:
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
}));
```

#### 4. Update `createMediaCtx` to include media-type-specific fields
**File**: `src/channels/telegram.test.ts`

```typescript
function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      // Default media fields so handlers don't crash
      photo: [{ file_id: 'photo-file-id', width: 800, height: 600 }],
      video: { file_id: 'video-file-id' },
      voice: { file_id: 'voice-file-id' },
      audio: { file_id: 'audio-file-id' },
      document: { file_id: 'doc-file-id', file_name: 'report.pdf' },
      sticker: { file_id: 'sticker-file-id', emoji: '😂' },
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}
```

#### 5. Update existing media content assertions
**File**: `src/channels/telegram.test.ts`
**Changes**: Existing tests that check `[Photo]` should now expect `[Photo saved: media/photo_1.jpg]` etc.

```typescript
it('stores photo with downloaded file path', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:photo', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Photo saved: media/photo_1.jpg]' }),
  );
});

it('stores photo with caption after file path', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({ caption: 'Look at this' });
  await triggerMediaMessage('message:photo', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({
      content: '[Photo saved: media/photo_1.jpg] Look at this',
    }),
  );
});
```

#### 6. Add new test cases

```typescript
it('falls back to placeholder when download fails', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:photo', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Photo]' }),
  );
});

it('falls back to placeholder when file exceeds 20MB', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  currentBot().api.getFile.mockResolvedValueOnce({
    file_id: 'big-file',
    file_path: 'videos/big.mp4',
    file_size: 25 * 1024 * 1024, // 25MB
  });

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:video', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Video]' }),
  );
});

it('falls back to placeholder when fetch returns non-ok', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 404,
  } as Response);

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:photo', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Photo]' }),
  );
});

it('creates media directory with recursive flag', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:photo', ctx);

  expect(fs.mkdir).toHaveBeenCalledWith(
    '/tmp/test-groups/test-group/media',
    { recursive: true },
  );
});

it('writes file buffer to correct path', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({ messageId: 42 });
  await triggerMediaMessage('message:photo', ctx);

  expect(fs.writeFile).toHaveBeenCalledWith(
    '/tmp/test-groups/test-group/media/photo_42.jpg',
    expect.any(Buffer),
  );
});

it('downloads document with original extension', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({
    messageId: 7,
    extra: { document: { file_id: 'doc-id', file_name: 'report.pdf' } },
  });
  await triggerMediaMessage('message:document', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({
      content: '[Document saved: media/document_7.pdf]',
    }),
  );
});

it('downloads sticker as webp', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({
    messageId: 5,
    extra: { sticker: { file_id: 'sticker-id', emoji: '🔥' } },
  });
  await triggerMediaMessage('message:sticker', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({
      content: '[Sticker saved: media/sticker_5.webp]',
    }),
  );
});

it('location stays as placeholder (no download)', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:location', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Location]' }),
  );
  expect(currentBot().api.getFile).not.toHaveBeenCalled();
});

it('contact stays as placeholder (no download)', async () => {
  const opts = createTestOpts();
  const channel = new TelegramChannel('test-token', opts);
  await channel.connect();

  const ctx = createMediaCtx({});
  await triggerMediaMessage('message:contact', ctx);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'tg:100200300',
    expect.objectContaining({ content: '[Contact]' }),
  );
  expect(currentBot().api.getFile).not.toHaveBeenCalled();
});
```

### Success Criteria:

#### Automated Verification:
- [x] All tests pass (`npm test`)
- [x] TypeScript compiles without errors (`npm run build`)
- [x] No lint errors

#### Manual Verification:
- [ ] Send a photo to the Telegram bot → check `groups/<folder>/media/photo_<id>.jpg` exists
- [ ] Send a document → check file saved with correct extension
- [ ] Send a photo with caption → message content includes both path and caption
- [ ] Verify the agent can reference the file from inside the container at `/workspace/group/media/`

**Implementation Note**: After all automated verification passes, test manually with a real Telegram bot before considering the feature complete.

---

## Testing Strategy

### Unit Tests:
- Download success → content string includes saved path
- Download failure (API error) → falls back to placeholder
- File exceeds 20MB → falls back to placeholder
- Fetch returns non-ok → falls back to placeholder
- `getFile` returns no `file_path` → falls back to placeholder
- Correct directory creation (`fs.mkdir` with `recursive: true`)
- Correct file write path (`fs.writeFile` with expected path)
- Each media type produces correct label and extension
- Caption preserved alongside file path
- Location/contact remain as placeholders (no download attempted)
- Unregistered chats still ignored

**Test harness note**: The existing `triggerMediaMessage()` helper already `await`s each handler (`for (const h of handlers) await h(ctx)`), so async handlers are correctly awaited in tests. No changes needed to the test infrastructure.

### Manual Testing Steps:
1. Send a photo → verify file saved and content shows path
2. Send a video → verify `.mp4` saved
3. Send a voice message → verify `.ogg` saved
4. Send an audio file → verify `.mp3` saved
5. Send a PDF document → verify `.pdf` saved with correct extension
6. Send a sticker → verify `.webp` saved
7. Send a photo with caption → verify caption appears after path
8. Send a file > 20MB → verify placeholder is used, warning logged
9. Verify agent can read the saved file from inside the container

## References

- Original ticket: `thoughts/shared/tickets/2026-03-09-telegram-media-downloads.md`
- Grammy Bot API docs: `getFile` method
- Existing pattern: `.claude/skills/add-image-vision/add/src/image.ts` (WhatsApp image save flow)
