/**
 * Report markdown → sanitized HTML pipeline.
 *
 * Extracted to its own module so tests can import the renderer without
 * pulling in db.ts / ios-data-api.ts and their module-load side effects.
 *
 * Pip is an LLM and any user who can talk to Pip in any group can
 * prompt-inject HTML/script payloads into a report body. The dashboard
 * renders these on the same origin as the vault, dev-tasks, and meal-plan
 * APIs, so a sanitizer bypass would be a full XSS→data-exfil chain. The
 * allowlist below is fixed and narrow. See plan §Key Technical Decisions.
 */

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const REPORT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'ul',
    'ol',
    'li',
    'code',
    'pre',
    'a',
    'strong',
    'em',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'hr',
    'br',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      },
    }),
  },
  // Disallow everything not explicitly allowed above (including img, svg,
  // iframe, script, style, form, input, etc.). sanitize-html defaults are
  // already strict — this is belt-and-braces.
  disallowedTagsMode: 'discard',
};

/**
 * Wrap every top-level `<table>…</table>` block in a
 * `<div class="report-table-wrap">` so the dashboard can give
 * tables their own horizontal scroller. Report authors (Pip) love
 * wide matrix comparisons that blow past 68ch — without the wrapper
 * the whole page slides sideways on mobile and the browser zooms
 * out to fit.
 *
 * Applied AFTER sanitization so the sanitizer's strict tag allowlist
 * (which doesn't include `<div>`) stays untouched. Safe because the
 * tag names `<table>` / `</table>` can't appear inside text at this
 * point — they'd have been escaped by the markdown parser or
 * stripped by the sanitizer.
 */
function wrapTables(html: string): string {
  return html.replace(
    /<table[\s\S]*?<\/table>/g,
    (match) => `<div class="report-table-wrap">${match}</div>`,
  );
}

export function renderReportMarkdown(md: string): string {
  const rawHtml = marked.parse(md, { async: false }) as string;
  const sanitized = sanitizeHtml(rawHtml, REPORT_SANITIZE_OPTIONS);
  return wrapTables(sanitized);
}
