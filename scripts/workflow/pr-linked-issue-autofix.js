const CLOSES_KEYWORD_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+\b/i;
const GENERIC_ISSUE_REF_RE = /\B#\d+\b/;
const MAINTENANCE_FALLBACK_RE =
  /\b(?:No issue|N\/A)\s*:\s*(maintenance|docs|governance|automation|admin)\b/i;
const LINKED_WORK_ITEM_HEADING_RE = /^##\s+Linked Work Item\s*$/im;
const LINKED_WORK_ITEM_SECTION_START_RE = /^##\s+Linked Work Item\s*\n+/im;
const PLACEHOLDER_LINE_RE = /^- Fixes #<issue-id>\s*$/im;
const AUTOFIX_MARKER = '<!-- pr-linked-issue-autofix: maintenance -->';
const MAINTENANCE_LINE = '- No issue: maintenance';

const NON_PRODUCT_PREFIXES = [
  '.github/',
  '.claude/',
  '.codex/',
  'docs/',
  'launchd/',
  'scripts/workflow/',
];

export function hasLinkedIssue(body = '') {
  return (
    CLOSES_KEYWORD_RE.test(body) ||
    GENERIC_ISSUE_REF_RE.test(body) ||
    MAINTENANCE_FALLBACK_RE.test(body)
  );
}

export function isMaintenanceOnlyChange(files = []) {
  return (
    files.length > 0 &&
    files.every((file) =>
      NON_PRODUCT_PREFIXES.some((prefix) => file.startsWith(prefix)),
    )
  );
}

export function applyMaintenanceFallback(body = '') {
  if (hasLinkedIssue(body)) {
    return body;
  }

  const fallbackBlock = `${MAINTENANCE_LINE}\n${AUTOFIX_MARKER}`;

  if (PLACEHOLDER_LINE_RE.test(body)) {
    return body.replace(PLACEHOLDER_LINE_RE, fallbackBlock);
  }

  if (LINKED_WORK_ITEM_HEADING_RE.test(body)) {
    return body.replace(
      LINKED_WORK_ITEM_SECTION_START_RE,
      () => `## Linked Work Item\n\n${fallbackBlock}\n`,
    );
  }

  const prefix = `## Linked Work Item\n\n${fallbackBlock}\n\n`;
  return `${prefix}${body}`.trimEnd();
}

export function planPrLinkedIssueAutofix({
  title = '',
  body = '',
  files = [],
} = {}) {
  if (hasLinkedIssue(body)) {
    return {
      shouldFix: false,
      reason: 'already_linked',
      updatedBody: body,
      title,
      files,
    };
  }

  if (!isMaintenanceOnlyChange(files)) {
    return {
      shouldFix: false,
      reason: 'ambiguous_scope',
      updatedBody: body,
      title,
      files,
    };
  }

  return {
    shouldFix: true,
    reason: 'maintenance_fallback',
    updatedBody: applyMaintenanceFallback(body),
    title,
    files,
  };
}
