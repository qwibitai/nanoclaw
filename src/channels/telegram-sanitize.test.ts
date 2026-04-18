import { describe, it, expect } from 'vitest';
import { sanitizeTelegramHtml } from './telegram-sanitize.js';

describe('sanitizeTelegramHtml — Markdown → HTML', () => {
  it('converts **bold** to <b>', () => {
    expect(sanitizeTelegramHtml('say **this** now')).toBe(
      'say <b>this</b> now',
    );
  });

  it('converts __bold__ to <b>', () => {
    expect(sanitizeTelegramHtml('__emphasis__')).toBe('<b>emphasis</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(sanitizeTelegramHtml('feeling *great* today')).toBe(
      'feeling <i>great</i> today',
    );
  });

  it('converts _italic_ to <i>', () => {
    expect(sanitizeTelegramHtml('feeling _great_ today')).toBe(
      'feeling <i>great</i> today',
    );
  });

  it('converts `code` to <code>', () => {
    expect(sanitizeTelegramHtml('run `npm test`')).toBe(
      'run <code>npm test</code>',
    );
  });

  it('converts [text](url) to <a href>', () => {
    expect(sanitizeTelegramHtml('[Docs](https://example.com)')).toBe(
      '<a href="https://example.com">Docs</a>',
    );
  });

  it('converts # headings to <b>', () => {
    expect(sanitizeTelegramHtml('# Top\n## Sub\n### Detail')).toBe(
      '<b>Top</b>\n<b>Sub</b>\n<b>Detail</b>',
    );
  });

  it('converts - and * bullets to •', () => {
    expect(sanitizeTelegramHtml('- one\n* two\n- three')).toBe(
      '\u2022 one\n\u2022 two\n\u2022 three',
    );
  });

  it('handles mixed content in one pass', () => {
    const input = '**Bug fix**: see [ticket](https://jira.example.com/T-1) now';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>Bug fix</b>: see <a href="https://jira.example.com/T-1">ticket</a> now',
    );
  });
});

describe('sanitizeTelegramHtml — idempotence (pre-formatted HTML)', () => {
  it('passes well-formed HTML through unchanged', () => {
    const html = '<b>bold</b> and <i>italic</i> with <code>code</code>';
    expect(sanitizeTelegramHtml(html)).toBe(html);
  });

  it('is idempotent — running twice produces the same result', () => {
    const input = '**bold** and *italic* and [link](https://a.com)';
    const once = sanitizeTelegramHtml(input);
    expect(sanitizeTelegramHtml(once)).toBe(once);
  });

  it('preserves <a href> tags even when text contains underscores', () => {
    const input = '<a href="https://a.com/path_with_underscores">click</a>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });
});

describe('sanitizeTelegramHtml — protected regions', () => {
  it('does not transform underscores inside URLs', () => {
    const input = 'see https://example.com/path_with_underscores for details';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('does not transform underscores inside email addresses', () => {
    const input = 'contact foo_bar@example.com please';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('preserves ftp URLs', () => {
    const input = 'archive at ftp://files.example.com/path_name';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('inline code blocks with * characters are not mangled', () => {
    expect(sanitizeTelegramHtml('use `a*b*c` as the pattern')).toBe(
      'use <code>a*b*c</code> as the pattern',
    );
  });
});

describe('sanitizeTelegramHtml — edge cases', () => {
  it('empty input returns empty', () => {
    expect(sanitizeTelegramHtml('')).toBe('');
  });

  it('text with no Markdown passes through unchanged', () => {
    expect(sanitizeTelegramHtml('plain text here')).toBe('plain text here');
  });

  it('lone asterisk is not treated as italic', () => {
    expect(sanitizeTelegramHtml('use a * b for multiply')).toBe(
      'use a * b for multiply',
    );
  });

  it('snake_case_identifier is not treated as italic', () => {
    expect(sanitizeTelegramHtml('call my_func_name please')).toBe(
      'call my_func_name please',
    );
  });

  it('handles multi-line mixed input', () => {
    const input = '# Release\n- **feat**: added X\n- _fix_: Y';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>Release</b>\n\u2022 <b>feat</b>: added X\n\u2022 <i>fix</i>: Y',
    );
  });
});

// --- HTML entity safety: captured text must be escaped before insertion ---
describe('sanitizeTelegramHtml — HTML entity escaping', () => {
  it('escapes & inside **bold** so Telegram does not reject the entity', () => {
    expect(sanitizeTelegramHtml('**Jack & Jill**')).toBe(
      '<b>Jack &amp; Jill</b>',
    );
  });

  it('escapes comparison operators inside *italic* captured text', () => {
    // Using `>` that isn't part of a tag pattern (no `<…>`) so it stays as
    // content that Phase 2 captures and escapes.
    expect(sanitizeTelegramHtml('say *5 > 3 && 1 < 2* today')).toBe(
      'say <i>5 &gt; 3 &amp;&amp; 1 &lt; 2</i> today',
    );
  });

  it('escapes quotes and special chars in link text', () => {
    expect(sanitizeTelegramHtml('[Jack & Jill](https://example.com/a)')).toBe(
      '<a href="https://example.com/a">Jack &amp; Jill</a>',
    );
  });

  it('escapes & inside inline code', () => {
    expect(sanitizeTelegramHtml('run `x && y` now')).toBe(
      'run <code>x &amp;&amp; y</code> now',
    );
  });

  it('escapes < > & in headings', () => {
    expect(sanitizeTelegramHtml('# Release < v2 & later')).toBe(
      '<b>Release &lt; v2 &amp; later</b>',
    );
  });
});

// --- Existing HTML element spans: contents must be preserved verbatim ---
describe('sanitizeTelegramHtml — whole HTML spans protected', () => {
  it('<code>*literal*</code> — Markdown inside code is not rewritten', () => {
    const input = 'pattern: <code>*literal*</code>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<pre>__init__</pre> — Python dunder survives intact', () => {
    const input = 'see <pre>__init__</pre>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<b>**already bold**</b> — inner markers are not double-processed', () => {
    const input = '<b>**already bold**</b>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<a href="...">text_with_underscores</a> — link text underscores preserved', () => {
    const input = '<a href="https://example.com">foo_bar_baz</a>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<blockquote>*italic inside quote*</blockquote> — quote contents preserved', () => {
    const input = '<blockquote>*keep as-is*</blockquote>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });
});

// --- Fenced code blocks must never be rewritten ---
describe('sanitizeTelegramHtml — fenced code blocks', () => {
  it('triple-backtick block is wrapped in <pre> with contents escaped', () => {
    const input = '```\n**not bold**\n__init__\n```';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<pre>**not bold**\n__init__</pre>',
    );
  });

  it('fenced block with language hint is preserved', () => {
    const input = '```python\nif x < 5:\n    print("a & b")\n```';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<pre>if x &lt; 5:\n    print(&quot;a &amp; b&quot;)</pre>',
    );
  });

  it('Markdown outside fenced block is still processed', () => {
    const input = '**bold** before\n```\n**raw**\n```\n**bold** after';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>bold</b> before\n<pre>**raw**</pre>\n<b>bold</b> after',
    );
  });
});

// --- Defensive: the `*bold*` that the old parseTextStyles used to emit
//     is no longer reached now that telegram is passthrough. Pinned here
//     as the definition of current behavior: lone `*foo*` is italic,
//     NOT bold. If you ever reintroduce WhatsApp-style markers in
//     parseTextStyles, this test tells you what breaks.
describe('sanitizeTelegramHtml — contract with parseTextStyles', () => {
  it('lone *foo* is italic (would be wrong if parseTextStyles emitted *bold*)', () => {
    expect(sanitizeTelegramHtml('say *foo* now')).toBe('say <i>foo</i> now');
  });
});
