export interface PhantomMatch {
  phantom: boolean;
  matched?: string;
}

interface PhantomPattern {
  name: string;
  pattern: RegExp;
}

export const PHANTOM_PATTERNS: PhantomPattern[] = [
  {
    name: 'feed-health-workspace-unmounted',
    pattern:
      /feed\s+health\s+check\b[\s\S]{0,800}\b(workspace\s+unmounted|all\s+rss\s+feeds\s+inaccessible|awaiting\s+remount)/i,
  },
  {
    name: 'workspace-unmounted-day-alert',
    pattern:
      /workspace\s+unmounted\b[\s\S]{0,160}\bday\s+\d{1,3}\b[\s\S]{0,800}\b(all\s+rss\s+feeds\s+inaccessible|awaiting\s+remount|entries\s+buffered)/i,
  },
  {
    name: 'memory-maintenance-write-loop',
    pattern:
      /memory\s+maintenance\s+alert\b[\s\S]{0,800}\b(awaiting\s+(workspace\s+)?(mount|restore)|pending\s+writ(e|ten)[-\s]?back|queue\s+submission)/i,
  },
  {
    name: 'no-response-needed-workspace-loop',
    pattern:
      /no\s+response\s+needed\b[\s\S]{0,240}\b(awaiting\s+(workspace\s+)?(mount|restore)|pending\s+writ(e|ten)[-\s]?back|queue\s+submission)/i,
  },
];

export function isPhantomText(text: string): PhantomMatch {
  const trimmed = text.trim();
  if (!trimmed) return { phantom: false };

  for (const { name, pattern } of PHANTOM_PATTERNS) {
    if (pattern.test(trimmed)) return { phantom: true, matched: name };
  }

  return { phantom: false };
}

export function extractOutboundText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';

  const record = content as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['text', 'body', 'message', 'title', 'description']) {
    const value = record[key];
    if (typeof value === 'string') parts.push(value);
  }

  return parts.join('\n');
}

export function isPhantomOutboundContent(content: unknown): PhantomMatch {
  return isPhantomText(extractOutboundText(content));
}
