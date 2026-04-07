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

export function renderReportMarkdown(md: string): string {
  const rawHtml = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(rawHtml, REPORT_SANITIZE_OPTIONS);
}
