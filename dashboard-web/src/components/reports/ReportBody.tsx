/**
 * Report prose renderer.
 *
 * This is the ONLY component in dashboard-web that renders opaque
 * HTML from a server response. It accepts a SanitizedHtml value
 * (branded type, only mintable inside lib/api.ts's fetchReport) so
 * any accidental attempt to pass a raw string from somewhere else
 * becomes a TypeScript error at the call site.
 *
 * The actual sanitization lives in nanoclaw/src/channels/
 * dashboard-report-render.ts — marked + sanitize-html with a narrow
 * tag/attribute allowlist (no <img>, no <svg>, no <iframe>, no
 * event handlers). The React app never imports marked, markdown-it,
 * react-markdown, dompurify, or sanitize-html — the sanitizer stays
 * in one place on the server.
 *
 * Typography is defined in src/app.css under .report-body using a
 * small set of element selectors. See the plan Unit 6 typographic
 * spec table for the locked values.
 */

import type { SanitizedHtml } from "@/types";

interface ReportBodyProps {
  html: SanitizedHtml;
}

export function ReportBody({ html }: ReportBodyProps) {
  return (
    <div
      className="report-body"
      data-testid="report-body"
      // SanitizedHtml is a branded type that only api.ts can mint
      // via fetchReport(). This is the single approved
      // dangerouslySetInnerHTML call site in the entire dashboard.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
