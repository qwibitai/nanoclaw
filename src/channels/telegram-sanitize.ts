/**
 * Markdown → Telegram HTML sanitizer, ported from and hardened beyond
 * an internal prototype.
 *
 * Run at Telegram send time so agent discipline stops mattering: if a skill
 * (or a subagent, or a forgetful prompt) produces Markdown, we convert it to
 * Telegram-flavored HTML here. Idempotent — already-valid HTML passes through.
 *
 * Protected regions (never rewritten):
 *   - Fenced code blocks (```...```) — preserved as <pre> with contents escaped.
 *   - Whole inline HTML element spans (`<code>…</code>`, `<pre>…</pre>`,
 *     `<b>…</b>`, `<i>…</i>`, `<u>…</u>`, `<s>…</s>`, `<a>…</a>`,
 *     `<blockquote>…</blockquote>`, `<tg-spoiler>…</tg-spoiler>`) — the
 *     element AND its contents are protected, so Markdown markers inside
 *     pre-formatted HTML (e.g. `<code>*literal*</code>`) aren't rewritten.
 *   - Stray HTML tag tokens (self-closing, mismatched).
 *   - http / https / ftp URLs, email addresses.
 *
 * Converted patterns (captured text is HTML-escaped before insertion so
 * characters like `&`, `<`, `>`, `"` in content don't produce invalid entities):
 *   [text](url)      → <a href="url">text</a>
 *   `code`           → <code>code</code>
 *   **bold** / __b__ → <b>bold</b>
 *   *italic* / _i_   → <i>italic</i>  (only when delimiters look like formatting)
 *   # heading        → <b>heading</b> (line-start, 1-6 hashes)
 *   - item / * item  → • item (line-start bullet)
 */

const PH_PREFIX = '\u0000PH';
const PH_SUFFIX = '\u0000';

/** Escape `&`, `<`, `>`, `"` so captured text is safe inside HTML content / attributes. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline HTML tags whose full span (opening + contents + closing) must be
 * treated as opaque. Order matters only inside this list for readability.
 */
const PROTECTED_SPAN_TAGS = [
  'pre',
  'code',
  'blockquote',
  'a',
  'b',
  'i',
  'u',
  's',
  'tg-spoiler',
];

export function sanitizeTelegramHtml(text: string): string {
  if (!text) return text;

  const placeholders: string[] = [];
  const protect = (match: string): string => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `${PH_PREFIX}${idx}${PH_SUFFIX}`;
  };

  let out = text;

  // Phase 0: fenced code blocks — stash entire ```…``` regions, rewritten
  // into <pre> with contents HTML-escaped so code samples containing `**`
  // or `_` or `<` aren't mangled downstream.
  out = out.replace(
    /```(?:[\w-]+)?\r?\n([\s\S]*?)\r?\n```/g,
    (_m, code: string) => protect(`<pre>${htmlEscape(code)}</pre>`),
  );
  // Single-line / unterminated fenced blocks (defensive — less common).
  out = out.replace(/```([\s\S]*?)```/g, (_m, code: string) =>
    protect(`<pre>${htmlEscape(code)}</pre>`),
  );

  // Phase 1a: protect full HTML element spans (tag + contents + closing tag)
  // so Markdown markers inside already-formatted HTML remain literal.
  // Non-greedy; does not attempt to handle nesting of the same tag.
  for (const tag of PROTECTED_SPAN_TAGS) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(re, protect);
  }

  // Phase 1b: protect stray tag tokens (self-closing, mismatched, or tags
  // we don't recognise as span-ful). This keeps any remaining raw HTML from
  // being touched, even if we can't pair it.
  out = out.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\s*\/?>/g, protect);

  // Phase 1c: protect URLs and email addresses so their underscores/dots
  // don't get mistaken for Markdown formatting.
  out = out.replace(/https?:\/\/[^\s<>")\]]+/g, protect);
  out = out.replace(/ftp:\/\/[^\s<>")\]]+/g, protect);
  out = out.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/g, protect);

  // Phase 2: Markdown → HTML. Captured groups are HTML-escaped before
  // being written back so `**a & b**` → `<b>a &amp; b</b>`, not raw `&`.
  // 2a. Links — url may be a placeholder from Phase 1c.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, txt: string, url: string) =>
      `<a href="${htmlEscape(url)}">${htmlEscape(txt)}</a>`,
  );

  // 2b. Inline code — before bold/italic so backticked content isn't mangled.
  out = out.replace(
    /`([^`\n]+)`/g,
    (_m, code: string) => `<code>${htmlEscape(code)}</code>`,
  );

  // 2c. Bold: **x** or __x__
  out = out.replace(
    /\*\*(.+?)\*\*/g,
    (_m, t: string) => `<b>${htmlEscape(t)}</b>`,
  );
  out = out.replace(/__(.+?)__/g, (_m, t: string) => `<b>${htmlEscape(t)}</b>`);

  // 2d. Italic: *x* or _x_ — must look like formatting, not identifier parts.
  out = out.replace(
    /(^|[^\w])\*(\S(?:.*?\S)?)\*(?!\w)/g,
    (_m, pre: string, t: string) => `${pre}<i>${htmlEscape(t)}</i>`,
  );
  out = out.replace(
    /(^|[^\w])_(\S(?:.*?\S)?)_(?!\w)/g,
    (_m, pre: string, t: string) => `${pre}<i>${htmlEscape(t)}</i>`,
  );

  // 2e. Headings: # to ###### at line start → <b>…</b>
  out = out.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_m, t: string) => `<b>${htmlEscape(t)}</b>`,
  );

  // 2f. Bullets: - item / * item at line start → • item
  out = out.replace(/^[-*]\s+/gm, '\u2022 ');

  // Phase 3: restore placeholders.
  out = out.replace(
    new RegExp(`${PH_PREFIX}(\\d+)${PH_SUFFIX}`, 'g'),
    (_m, idx: string) => placeholders[Number(idx)],
  );

  return out;
}
