import { describe, expect, it } from 'vitest';
import { renderReportMarkdown } from './dashboard-report-render.js';

/**
 * XSS fixture test for the report markdown renderer.
 *
 * Pip is an LLM and any user who can talk to Pip in any group can
 * prompt-inject HTML/script payloads into a report body. The dashboard
 * renders these on the same origin as the vault, dev-tasks, and meal-plan
 * APIs, so a sanitizer bypass = full data exfil chain. These tests are
 * non-negotiable.
 */

describe('renderReportMarkdown (sanitizer)', () => {
  function rendered(md: string): string {
    return renderReportMarkdown(md);
  }

  // --- Script tag injection ---

  it('strips top-level <script> tags embedded in markdown', () => {
    const out = rendered('Hello <script>alert(1)</script> world');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('renders <script> inside fenced code blocks as code, not as tags', () => {
    const out = rendered('```\n<script>alert(1)</script>\n```');
    // Code blocks escape their contents — the literal text should appear,
    // but inside <pre><code>, not as a live tag.
    expect(out).toContain('<pre>');
    expect(out).toContain('&lt;script');
    expect(out).not.toMatch(/<script[^-]/i);
  });

  it('strips <script> with attributes and weird whitespace', () => {
    const out = rendered('<script\nsrc="evil.js">x</script>');
    expect(out.toLowerCase()).not.toContain('<script');
  });

  // --- Event handlers ---

  it('strips inline event handlers from allowed tags', () => {
    // Raw HTML in markdown — even on allowed tags, attributes must be scrubbed.
    const out = rendered(
      '<a href="http://example.com" onclick="alert(1)">link</a>',
    );
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('strips onerror from embedded img tags (img itself is disallowed)', () => {
    const out = rendered('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
  });

  // --- Dangerous URL schemes ---

  it('strips javascript: URLs from links', () => {
    const out = rendered('[click](javascript:alert(1))');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('strips data: URLs from links', () => {
    const out = rendered('[click](data:text/html,<script>alert(1)</script>)');
    expect(out.toLowerCase()).not.toContain('data:text/html');
    expect(out).not.toContain('<script');
  });

  it('allows http, https, and mailto URLs', () => {
    expect(rendered('[a](http://example.com)')).toContain(
      'href="http://example.com"',
    );
    expect(rendered('[a](https://example.com)')).toContain(
      'href="https://example.com"',
    );
    expect(rendered('[a](mailto:test@example.com)')).toContain(
      'mailto:test@example.com',
    );
  });

  // --- Dangerous tags ---

  it('strips <iframe>', () => {
    const out = rendered('<iframe src="evil.html"></iframe>');
    expect(out).not.toContain('<iframe');
  });

  it('strips <object> and <embed>', () => {
    const out = rendered('<object data="x"></object><embed src="y">');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  it('strips <svg> (blocks foreignObject/script tricks)', () => {
    const out = rendered('<svg><script>alert(1)</script></svg>');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<script');
  });

  it('strips <style> (blocks CSS expression-based attacks)', () => {
    const out = rendered('<style>body { background: red }</style>');
    expect(out).not.toContain('<style');
  });

  it('strips <form> and <input>', () => {
    const out = rendered('<form><input type="text"></form>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });

  it('strips <base> (blocks href base hijacking)', () => {
    const out = rendered('<base href="http://evil.com/">');
    expect(out).not.toContain('<base');
  });

  it('strips <meta> refresh', () => {
    const out = rendered(
      '<meta http-equiv="refresh" content="0;url=http://evil.com">',
    );
    expect(out).not.toContain('<meta');
  });

  // --- Link rewriting ---

  it('forces rel=noopener/noreferrer/nofollow and target=_blank on anchors', () => {
    const out = rendered('[click](https://example.com)');
    expect(out).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(out).toMatch(/target="_blank"/);
  });

  // --- Allowed content round-trips ---

  it('preserves headings, lists, code, tables, blockquotes, strong, em', () => {
    const md = [
      '# H1',
      '## H2',
      '',
      '- item 1',
      '- item 2',
      '',
      '**bold** and *italic* text',
      '',
      '> a quote',
      '',
      '| col1 | col2 |',
      '|------|------|',
      '| a    | b    |',
      '',
      '```',
      'code block',
      '```',
    ].join('\n');
    const out = rendered(md);
    expect(out).toContain('<h1');
    expect(out).toContain('<h2');
    expect(out).toContain('<ul');
    expect(out).toContain('<li');
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>');
    expect(out).toContain('<blockquote');
    expect(out).toContain('<table');
    expect(out).toContain('<pre');
    expect(out).toContain('<code');
  });
});
