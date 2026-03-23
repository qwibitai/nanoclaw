# Optional Refactor: Media Support Code Cleanup

**Status:** Not started — pick up when convenient. Zero functionality changes.

## Items

### 1. WhatsApp: Extract media download helper (`src/channels/whatsapp.ts`)
Lines 241-314 repeat the same download/push pattern 5 times (image, video, audio, document, sticker). Extract a shared `extractDownloadable()` helper. ~70 lines saved.

### 2. WhatsApp: Remove `hasMedia` flag (`src/channels/whatsapp.ts`)
Replace with `rawParts.some(p => p.type !== 'text')` — functionally identical, one less mutable variable.

### 3. Telegram: Media handler factory (`src/channels/telegram.ts`)
Lines 246-320: seven near-identical handlers. Replace with a factory + loop over a config array. ~60 lines saved.

### 4. Telegram: Replace `console.log` with `logger.info` (`src/channels/telegram.ts`)
Lines 362-365: two bare `console.log()` calls in `connect()` startup.

### 5. Router: Collapse media switch cases (`src/router.ts`)
Five identical cases (image, voice, video, audio, sticker) all produce `<media type="X" path="Y" />`. Collapse into a `Set` check + default case.

### 6. Handlers: Trim pdf-extract.js logging (`container/handlers/pdf-extract.js`)
12 log statements in ~80 lines. Keep only error/skip paths and final success summary.

### 7. Handlers: Log errors in voice-openai.js catch (`container/handlers/voice-openai.js`)
Line 32-34: silent `catch { return null; }` swallows all errors. Add error logging.

### 8. Channels index: Remove dead comments (`src/channels/index.ts`)
Empty comment placeholders for discord/gmail/slack that don't exist yet.

## Not worth changing
- `src/container-runner.ts` sync patterns — intentionally different (skills iterates subdirs, handlers bulk-copies)
- `src/media.ts` type narrowing — ugly but contained, type guard adds code for minimal benefit
