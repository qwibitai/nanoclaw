export type TriageQueue =
  | 'attention'
  | 'archive_candidate'
  | 'action'
  | 'ignore';

export type ActionIntent =
  | 'bug_report'
  | 'sentry_alert'
  | 'dependabot'
  | 'security_alert'
  | 'deadline'
  | 'receipt'
  | 'knowledge_extract'
  | 'none';

export interface ExtractedFact {
  key: string;
  value: string;
  source_span: string;
}

export interface RepoCandidate {
  repo: string;
  score: number;
  signal: string;
}

export interface TriageDecision {
  queue: TriageQueue;
  confidence: number;
  reasons: string[];
  action_intent?: ActionIntent;
  facts_extracted: ExtractedFact[];
  repo_candidates: RepoCandidate[];
  attention_reason?: string;
  archive_category?: string;
}

export type ValidationResult =
  | { ok: true; value: TriageDecision }
  | { ok: false; error: string };

const VALID_QUEUES: ReadonlySet<string> = new Set([
  'attention',
  'archive_candidate',
  'action',
  'ignore',
]);
const VALID_INTENTS: ReadonlySet<string> = new Set([
  'bug_report',
  'sentry_alert',
  'dependabot',
  'security_alert',
  'deadline',
  'receipt',
  'knowledge_extract',
  'none',
]);

export function validateTriageDecision(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'decision is not an object' };
  }
  const d = raw as Record<string, unknown>;

  if (typeof d.queue !== 'string' || !VALID_QUEUES.has(d.queue)) {
    return { ok: false, error: `invalid queue: ${String(d.queue)}` };
  }
  if (
    typeof d.confidence !== 'number' ||
    d.confidence < 0 ||
    d.confidence > 1
  ) {
    return { ok: false, error: 'confidence must be number in [0,1]' };
  }
  if (!Array.isArray(d.reasons) || d.reasons.length < 2) {
    return { ok: false, error: 'reasons must have at least 2 reasons' };
  }
  if (d.reasons.some((r) => typeof r !== 'string')) {
    return { ok: false, error: 'reasons must all be strings' };
  }
  if (d.action_intent !== undefined && typeof d.action_intent === 'string') {
    if (!VALID_INTENTS.has(d.action_intent)) {
      return { ok: false, error: `invalid action_intent: ${d.action_intent}` };
    }
  }
  if (!Array.isArray(d.facts_extracted)) {
    return { ok: false, error: 'facts_extracted must be an array' };
  }
  if (!Array.isArray(d.repo_candidates)) {
    return { ok: false, error: 'repo_candidates must be an array' };
  }
  if (d.queue === 'attention' && typeof d.attention_reason !== 'string') {
    return {
      ok: false,
      error: 'attention_reason is required when queue=attention',
    };
  }
  if (
    d.queue === 'archive_candidate' &&
    typeof d.archive_category !== 'string'
  ) {
    return {
      ok: false,
      error: 'archive_category is required when queue=archive_candidate',
    };
  }

  return { ok: true, value: d as unknown as TriageDecision };
}
