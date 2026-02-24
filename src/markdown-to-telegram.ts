import { Marked, Renderer } from 'marked';

/**
 * Converts CommonMark/GFM markdown (as produced by Claude) to the
 * HTML subset accepted by Telegram's parse_mode: 'HTML'.
 *
 * Supported tags: <b> <i> <s> <u> <code> <pre> <a href> <blockquote>
 * Everything else degrades gracefully to plain text.
 */

function buildRenderer(): Renderer {
  const renderer = new Renderer();

  renderer.paragraph = function ({ tokens }) {
    return `${this.parser.parseInline(tokens)}\n\n`;
  };

  renderer.heading = function ({ tokens }) {
    return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
  };

  renderer.strong = function ({ tokens }) {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  };

  renderer.em = function ({ tokens }) {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  };

  renderer.del = function ({ tokens }) {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  };

  renderer.codespan = function ({ text }) {
    return `<code>${escapeHtml(text)}</code>`;
  };

  renderer.code = function ({ text, lang }) {
    const escaped = escapeHtml(text);
    return `<pre>${escaped}</pre>\n`;
  };

  renderer.link = function ({ href, tokens }) {
    return `<a href="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`;
  };

  renderer.blockquote = function ({ tokens }) {
    return `<blockquote>${this.parser.parse(tokens).trim()}</blockquote>\n`;
  };

  renderer.list = function (token) {
    const items = token.items.map((item, i) => {
      // Use parseInline on the first text token's children to avoid block-level
      // wrapping (<p> tags) inside list items.
      const first = item.tokens[0];
      const inner =
        first?.type === 'text' && 'tokens' in first && first.tokens
          ? this.parser.parseInline(first.tokens)
          : this.parser.parse(item.tokens).trim();

      const prefix = token.ordered ? `${(token.start as number) + i}.` : '•';
      return `${prefix} ${inner}`;
    });
    return `${items.join('\n')}\n`;
  };

  renderer.hr = function () {
    return '—\n';
  };

  renderer.br = function () {
    return '\n';
  };

  renderer.image = function ({ title, text }) {
    return title || text || '';
  };

  return renderer;
}

// Single instance — renderer is set once, not on every parse call
const markedInstance = new Marked({ renderer: buildRenderer(), gfm: true, breaks: false });

export function markdownToTelegramHtml(text: string): string {
  const html = markedInstance.parse(text) as string;
  return html.trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
