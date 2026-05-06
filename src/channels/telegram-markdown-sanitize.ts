/**
 * Sanitize outbound text for Telegram.
 *
 * The @chat-adapter/telegram adapter sends `parse_mode=Markdown` (legacy) for
 * every message. Any unbalanced `*`, `_`, `[`, `]` OUTSIDE of code in agent
 * output makes Telegram reject the message with "can't parse entities" — the
 * row is dropped after 3 retries. Agents produce long, unpredictable Markdown:
 * balancing heuristics can't catch every edge case.
 *
 * Strategy: drop Markdown formatting from prose (bold / italic / strikethrough
 * / links) so Telegram has no entities to misparse, but preserve code spans
 * (`inline` and ```fenced```) verbatim so file names, shell commands, and code
 * identifiers survive with their underscores and stars intact. Telegram's
 * legacy Markdown accepts balanced code spans, and our regex only captures
 * balanced pairs, so the parser never trips on them.
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
// Bare URL — captures everything up to the next whitespace or `)`. Trailing
// punctuation that's clearly not part of the URL (`,`, `.`, `!`, `?`, `;`,
// `:` at the very end) is excluded so sentence-ending URLs don't swallow it.
const URL_PATTERN = /https?:\/\/[^\s)<>]+/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';
const URL_PLACEHOLDER_PREFIX = '\x00URL';

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  // 1. Protect code spans from the prose-stripping pass below.
  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // 2. Drop the language tag on fenced code blocks that didn't have one
  //    treated as inline (we don't need to touch them here — handled when
  //    restoring, below).

  // 3. Link text — keep label + parenthesized URL.
  //    `[label](url)` → `label (url)`
  text = text.replace(/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, '$1 ($2)');

  // 3b. Protect bare URLs (incl. ones just unwrapped from `[label](url)`)
  //     from the prose-stripping pass. URLs like
  //     `…?response_type=code&client_id=X` contain underscores that the
  //     italic regex would otherwise eat, mangling the link.
  const urlSegments: string[] = [];
  text = text.replace(URL_PATTERN, (m) => {
    urlSegments.push(m);
    return `${URL_PLACEHOLDER_PREFIX}${urlSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // 4. Bold / italic / strikethrough — drop markers, keep text.
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+?)__/g, '$1');
  text = text.replace(/\*([^*\n]+?)\*/g, '$1');
  text = text.replace(/_([^_\n]+?)_/g, '$1');
  text = text.replace(/~~([^~\n]+?)~~/g, '$1');
  text = text.replace(/~([^~\n]+?)~/g, '$1');

  // 5. List bullets — normalize to Unicode bullet.
  text = text.replace(/^(\s*)[-+*]\s+/gm, '$1• ');

  // 5b. Horizontal rules (`---`, `***`, `___`) — drop entirely. The chat-sdk
  //     format converter parses these as HR nodes and re-stringifies them as
  //     `***`, which Telegram's legacy Markdown parser then sees as an
  //     unclosed bold marker → "can't parse entities" rejection.
  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');

  // 6. Final safety net: any STRAY `*`, `_`, `[`, `]` left in prose gets
  //    dropped. This catches unpaired single characters (e.g. a lone `*` used
  //    as punctuation, `file_name.py` written without backticks, etc.) that
  //    would otherwise look like unclosed entities to Telegram's parser.
  //    Code spans were lifted into placeholders in step 1 and are unaffected.
  text = text.replace(/[*_[\]]/g, '');

  // 7. Restore protected URLs verbatim.
  text = text.replace(new RegExp(`${URL_PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'), (_, i) => {
    return urlSegments[Number(i)];
  });

  // 8. Restore protected code spans verbatim.
  return text.replace(new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'), (_, i) => {
    const seg = codeSegments[Number(i)];
    // Strip language tag on fenced blocks (```python → ```).
    return seg.replace(/^```[a-zA-Z0-9_-]+\n/, '```\n');
  });
}
