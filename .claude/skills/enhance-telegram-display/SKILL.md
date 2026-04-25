---
name: enhance-telegram-display
description: Apply comprehensive Telegram message display enhancements including Markdown→HTML rendering, vertical table format with blockquote wrapping, and improved formatting. Use when user wants to improve Telegram message appearance, mentions "telegram display", "telegram formatting", "better telegram", or wants to apply display optimizations to their NanoClaw Telegram setup.
---

# Enhance Telegram Display

This skill applies a comprehensive set of display enhancements to NanoClaw's Telegram channel, making messages more readable and visually appealing. These optimizations have been battle-tested and significantly improve the user experience on mobile and desktop Telegram clients.

## What This Skill Does

Applies the following enhancements to Telegram message rendering:

1. **Markdown → HTML Conversion**
   - Switches from MarkdownV2 to HTML parse mode
   - Uses `marked` library for reliable Markdown parsing
   - Includes parse error fallback for robustness

2. **Enhanced Table Display**
   - Vertical list format: displays tables as "Field: Value" pairs
   - Bold table headers shown separately at the top
   - Blockquote wrapping for visual distinction (left border line)
   - Configurable format (pipe-separated or vertical)

3. **Smart Message Chunking**
   - `splitMarkdown()` splits long messages at paragraph/line boundaries
   - Avoids cutting inside code blocks
   - 3800-char limit per chunk (conservative margin for HTML tags)

4. **File Reference Protection**
   - `wrapFileRefs()` wraps filenames like `config.ts`, `README.md` in `<code>` tags
   - Prevents Telegram from auto-linking file extensions as domains

5. **Native Streaming via sendMessageDraft (Bot API 9.5)**
   - Uses `sendMessageDraft` instead of `editMessageText` workaround
   - Users see a native draft bubble updating in real-time as Claude responds
   - 1000ms throttle (was 2000ms with the old edit-based approach)
   - Final message sent via `sendMessage` when streaming completes

6. **Block-Level Separators**
   - Paragraphs, lists, and tables each append `\n` to prevent content bleeding together

## Prerequisites

Read `.nanoclaw/state.yaml`. If `telegram` is not listed under `applied_skills`, stop and tell the user to run `/add-telegram` first.

## Step 0: Ask the User (Required)

Before making any changes, use `AskUserQuestion` with `multiSelect: true` to ask:

**Question:** "Which Telegram display enhancements would you like to enable? (multi-select)"

**Options:**
- **A. Markdown → HTML Rendering (Recommended)** — Upgrades message format to HTML; bold, code blocks, and links render more reliably. Most other features depend on this.
- **B. Vertical Table Format (Mobile-Friendly)** — Renders tables as "Field: Value" rows instead of pipe-separated columns, easier to read on small screens. *Requires A*
- **C. File Reference Protection** — Prevents filenames like `config.ts`, `README.md` from being auto-linked by Telegram. *Requires A*
- **D. Native Streaming via sendMessageDraft (Bot API 9.5)** — Shows a live draft bubble while the AI responds, instead of the old send-then-edit approach.
- **E. Smart Long Message Splitting** — Splits long replies at paragraph boundaries, never mid-code-block.

Record the selection as `selectedFeatures`.

## Dependency Resolution

If **B or C** is selected but **A is not**, automatically add A to the selection and inform the user:

> "Features B and/or C require A (Markdown → HTML Rendering), which has been automatically added to your selection."

## Implementation Steps

### Feature A: Markdown → HTML Rendering *(execute only when A is selected)*

#### A.1 Install Dependencies

```bash
npm install marked
```

#### A.2 Create `src/channels/telegram-markdown.ts`

```typescript
import { marked, Renderer } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const renderer = new Renderer();

renderer.strong = ({ text }) => `<b>${text}</b>`;
renderer.em = ({ text }) => `<i>${text}</i>`;
renderer.codespan = ({ text }) => `<code>${escapeHtml(text)}</code>`;

renderer.code = ({ text, lang }) => {
  const escaped = escapeHtml(text);
  const cls = lang ? ` class="language-${lang}"` : '';
  return `<pre><code${cls}>${escaped}</code></pre>`;
};

renderer.link = ({ href, text }) => `<a href="${escapeHtml(href)}">${text}</a>`;

renderer.heading = ({ text }) => `<b>${text}</b>`;

// In marked v15, paragraph receives { text, tokens } where text is raw.
// We must call parseInline on tokens to get rendered inline HTML.
// Trailing \n ensures the paragraph is separated from the next block.
renderer.paragraph = function (this: Renderer & { parser: any }, { tokens }) {
  return this.parser.parseInline(tokens) + '\n';
};

// In marked v15, list receives the full token with items[] — body is not pre-rendered.
// Trailing \n ensures the list is separated from the next block.
renderer.list = function (
  this: Renderer & { parser: any },
  { items, ordered },
) {
  return items
    .map((item: any, index: number) => {
      const text = this.parser.parseInline(
        item.tokens[0]?.tokens ?? item.tokens,
      );
      if (ordered) {
        return `${index + 1}. ${text}`;
      }
      return `• ${text}`;
    })
    .join('\n') + '\n';
};

renderer.blockquote = function (this: Renderer & { parser: any }, { tokens }) {
  const inner = tokens
    .map((token: any) => {
      if (token.tokens) return this.parser.parseInline(token.tokens);
      return token.text ?? '';
    })
    .join('');
  return `<blockquote>${inner}</blockquote>`;
};

renderer.hr = () => '';
renderer.text = ({ text, escaped }: { text: string; escaped?: boolean }) =>
  escaped ? text : escapeHtml(text);

marked.use({ renderer });

export function markdownToTelegramHtml(text: string): string {
  return (marked.parse(text, { async: false }) as string).trim();
}
```

#### A.3 Update `src/channels/telegram.ts`

**Add import** at the top of the file:

```typescript
import { markdownToTelegramHtml } from './telegram-markdown.js';
```

**Update `_sendWithRetry`** to convert Markdown to HTML before sending:

```typescript
private async _sendWithRetry(
  chatId: string,
  text: string,
  maxRetries = 3,
): Promise<void> {
  const htmlText = markdownToTelegramHtml(text);
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.bot!.api.sendMessage(chatId, htmlText, {
        parse_mode: 'HTML',
      });
      return;
    } catch (err: any) {
      lastError = err;

      const isParseError =
        err?.message?.includes("can't parse entities") ||
        err?.description?.includes("can't parse entities");
      if (isParseError) {
        logger.warn(
          { jid: chatId, len: text.length },
          'HTML parse error, falling back to plain text',
        );
        await this.bot!.api.sendMessage(chatId, text);
        return;
      }

      const isNetworkError =
        err?.code === 'ECONNRESET' ||
        err?.code === 'ECONNREFUSED' ||
        err?.message?.includes('socket') ||
        err?.message?.includes('Network');

      if (!isNetworkError || attempt === maxRetries) {
        throw err;
      }

      logger.debug(
        { attempt, maxRetries, err },
        'Telegram network error, retrying...',
      );
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}
```

---

### Feature B: Vertical Table Format *(execute only when B is selected)*

#### B.1 Update `src/channels/telegram-markdown.ts`

**At the top of the file**, add the import after the existing `import { marked, Renderer } from 'marked';` line:

```typescript
import { TELEGRAM_TABLE_FORMAT } from '../config.js';
```

**Before `marked.use({ renderer })`**, add the helpers and table renderer:

```typescript
function getCellText(cell: any): string {
  return typeof cell === 'string' ? cell : cell.text;
}

const PIPE_SEPARATOR = ' | ';

renderer.table = ({ header, rows }) => {
  const headerCells = header.map(getCellText);

  let tableContent: string;
  if (TELEGRAM_TABLE_FORMAT === 'vertical') {
    // Vertical list format: show header first, then each row as "Field: Value" pairs
    const headerLine = `<b>${headerCells.join(PIPE_SEPARATOR)}</b>`;
    const sections = rows.map((row: any[]) => {
      const fields = row.map((cell: any, colIndex: number) => {
        const value = getCellText(cell);
        const fieldName = headerCells[colIndex] || `Column ${colIndex + 1}`;
        return `<b>${fieldName}:</b> ${value}`;
      });
      return fields.join('\n');
    });
    // \n\n between header and first row (one blank line, not three)
    tableContent = headerLine + '\n\n' + sections.join('\n\n');
  } else {
    // Pipe-separated format (default)
    const rowLines = rows.map((row: any[]) =>
      row.map(getCellText).join(PIPE_SEPARATOR),
    );
    tableContent = [headerCells.join(PIPE_SEPARATOR), ...rowLines].join('\n');
  }

  // Wrap table in blockquote for visual distinction.
  // Trailing \n separates the blockquote from the next paragraph/list.
  return `<blockquote>${tableContent}</blockquote>\n`;
};
```

#### B.2 Update `src/config.ts`

1. Add `'TELEGRAM_TABLE_FORMAT'` to the `readEnvFile` array
2. Add export at the end:

```typescript
// Telegram table format: 'pipe' (default) or 'vertical'
export const TELEGRAM_TABLE_FORMAT = (process.env.TELEGRAM_TABLE_FORMAT ||
  envConfig.TELEGRAM_TABLE_FORMAT ||
  'pipe') as 'pipe' | 'vertical';
```

#### B.3 Set table format in `.env` (optional, defaults to `'pipe'`)

```bash
# Telegram table format: 'pipe' (default) or 'vertical'
TELEGRAM_TABLE_FORMAT=vertical
```

---

### Feature C: File Reference Protection *(execute only when C is selected)*

#### C.1 Update `src/channels/telegram-markdown.ts`

Add `wrapFileRefs` **before** the `export function markdownToTelegramHtml` line:

```typescript
/**
 * Wrap bare file references (e.g. bridge.ts, config.md) in <code> tags to
 * prevent Telegram from auto-linking extensions like .ts or .md as domains.
 * Skips content already inside <pre> or <code> blocks.
 */
function wrapFileRefs(html: string): string {
  const fileRe =
    /\b([\w][\w.-]*\.(ts|tsx|js|jsx|py|go|md|json|yaml|yml|sh|css|html|txt|log|env|toml|lock))\b/g;
  let insideCode = 0;
  return html
    .split(/(<\/?(?:pre|code)[^>]*>)/)
    .map((seg, i) => {
      if (i % 2 === 1) {
        if (/^<(?:pre|code)/.test(seg)) insideCode++;
        else insideCode = Math.max(0, insideCode - 1);
        return seg;
      }
      return insideCode === 0 ? seg.replace(fileRe, '<code>$1</code>') : seg;
    })
    .join('');
}
```

Then update `markdownToTelegramHtml` to call it:

```typescript
export function markdownToTelegramHtml(text: string): string {
  const html = (marked.parse(text, { async: false }) as string).trim();
  return wrapFileRefs(html);
}
```

---

### Feature D: Native Streaming via sendMessageDraft *(execute only when D is selected)*

#### D.1 Replace the `// --- Native streaming ---` section in `src/channels/telegram.ts`

```typescript
// --- Native streaming via sendMessageDraft (Bot API 9.5) ---

private streamBuffer: Record<string, string> = {};
private streamTimer: Record<string, ReturnType<typeof setTimeout> | null> = {};
private streamDraftId: Record<string, number> = {};
private readonly STREAM_THROTTLE_MS = 1000;

/**
 * Stream a partial message to the user via sendMessageDraft.
 * Calls are throttled; each call sends the FULL accumulated text so far.
 * When finalizeStream() is called, the real message is sent and the draft
 * bubble disappears automatically.
 */
async sendStreamingChunk(jid: string, accumulatedText: string): Promise<void> {
  if (!this.bot) return;
  this.streamBuffer[jid] = accumulatedText;

  if (!this.streamDraftId[jid]) {
    this.streamDraftId[jid] = Date.now();
  }

  if (!this.streamTimer[jid]) {
    this.streamTimer[jid] = setTimeout(() => {
      this.streamTimer[jid] = null;
      void this._flushDraft(jid);
    }, this.STREAM_THROTTLE_MS);
  }
}

private async _flushDraft(jid: string): Promise<void> {
  const text = this.streamBuffer[jid];
  const draftId = this.streamDraftId[jid];
  if (!text || !draftId || !this.bot) return;
  const chatId = Number(jid.replace(/^tg:/, ''));
  try {
    await this.bot.api.sendMessageDraft(
      chatId,
      draftId,
      markdownToTelegramHtml(text.slice(0, 3800)),
      { parse_mode: 'HTML' },
    );
  } catch (err: any) {
    // Silently ignore draft failures — final message always sent in finalizeStream
    logger.debug({ jid, err: err?.message }, 'sendMessageDraft failed (will finalize normally)');
  }
}

/**
 * Finalize the streamed message: send the real message (draft disappears)
 * and clean up state. Uses smart splitMarkdown for long responses.
 */
async finalizeStream(jid: string): Promise<void> {
  if (this.streamTimer[jid]) {
    clearTimeout(this.streamTimer[jid]!);
    this.streamTimer[jid] = null;
  }
  const text = this.streamBuffer[jid];
  delete this.streamBuffer[jid];
  delete this.streamDraftId[jid];

  if (!text) return;

  await this.sendMessage(jid, text);
}
```

---

### Feature E: Smart Long Message Splitting *(execute only when E is selected)*

#### E.1 Add `splitMarkdown` to `src/channels/telegram.ts` (before the class definition)

```typescript
const CHUNK_LIMIT = 3800;

export function splitMarkdown(text: string): string[] {
  if (text.length <= CHUNK_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > CHUNK_LIMIT) {
    let splitAt = -1;
    let inCodeBlock = false;
    let lastSafeParagraph = -1;
    let lastSafeLine = -1;

    for (let i = 0; i < Math.min(remaining.length, CHUNK_LIMIT); i++) {
      if (remaining[i] === '`' && remaining.slice(i, i + 3) === '```') {
        const atLineStart = i === 0 || remaining[i - 1] === '\n';
        if (atLineStart) {
          inCodeBlock = !inCodeBlock;
          i += 2;
          continue;
        }
      }
      if (!inCodeBlock) {
        if (remaining[i] === '\n' && remaining[i + 1] === '\n') {
          lastSafeParagraph = i;
        } else if (remaining[i] === '\n') {
          lastSafeLine = i;
        }
      }
    }

    if (lastSafeParagraph > 500) splitAt = lastSafeParagraph;
    else if (lastSafeLine > 0) splitAt = lastSafeLine;
    else splitAt = CHUNK_LIMIT;

    chunks.push(remaining.slice(0, splitAt));
    const next = remaining.slice(splitAt);
    remaining = next.startsWith('\n\n')
      ? next.slice(2)
      : next.startsWith('\n')
        ? next.slice(1)
        : next;
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
```

#### E.2 Update `sendMessage` in `src/channels/telegram.ts`

Replace the hard-cut `MAX_LENGTH = 4096` logic with smart splitting:

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.bot) return;
  try {
    const numericId = jid.replace(/^tg:/, '');

    // Smart split at paragraph/line boundaries, avoiding code block mid-cuts
    const chunks = splitMarkdown(text);
    for (const chunk of chunks) {
      await this._sendWithRetry(numericId, chunk);
    }
  } catch (err) {
    logger.warn({ jid, err }, 'Telegram sendMessage failed');
  }
}
```

---

### Always: Build + Restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

**Test the enhancements** by sending a test message to your Telegram bot with:
- **Bold** and *italic* text
- `inline code` and code blocks
- Tables (will render with vertical format if Feature B + `TELEGRAM_TABLE_FORMAT=vertical` configured)
- Lists (bullet and numbered)
- Links
- File references like `config.ts` or `README.md` (should appear in code font if Feature C applied)

## Table Format Switching

Users can switch between table formats anytime using the `/switch-telegram-table` skill, which provides an interactive interface to choose between:
- **Vertical list**: Field-value pairs, better for mobile
- **Pipe-separated**: Traditional table format, more compact

## Benefits

- **Better readability**: HTML rendering is more reliable than MarkdownV2
- **Mobile-friendly**: Vertical tables work great on small screens
- **Visual distinction**: Blockquote wrapping makes tables stand out
- **Flexible**: Users can switch table formats based on preference
- **Robust**: Parse error fallback prevents message delivery failures
- **Native streaming**: `sendMessageDraft` shows a live draft bubble (no "edited" badge)
- **Smart chunking**: Long messages split at natural boundaries, never inside code blocks
- **File reference safety**: Filenames won't be misinterpreted as hyperlinks

## Troubleshooting

**Tables not showing with blockquote border:**
- Verify Telegram client is up to date
- Check that HTML parse mode is active (not MarkdownV2)

**Parse errors:**
- The fallback to plain text should handle this automatically
- Check logs for specific HTML parsing issues

**Vertical format not applying:**
- Verify `TELEGRAM_TABLE_FORMAT=vertical` in `.env`
- Restart the service after changing configuration

**Weird line breaks / content running together:**
- Ensure paragraph renderer appends `'\n'`
- Ensure list renderer appends `'\n'`
- Ensure table renderer appends `'\n'` after `</blockquote>`
- Ensure vertical table uses `'\n\n'` (not `'\n\n\n\n'`) between header and rows

**`sendMessageDraft` not working:**
- Requires Bot API 9.5 (released March 1, 2026) — available to all bots
- If it fails silently, the final message via `sendMessage` will still be delivered

## Notes

- This skill modifies core Telegram rendering behavior
- All existing Telegram groups will use the new formatting
- Changes are backward compatible (can revert by removing the code)
- The `/switch-telegram-table` skill is automatically available after applying these changes
- `sendMessageDraft` requires grammy ≥ 1.39.3 (native support, no type casting needed)
