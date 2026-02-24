export interface DispatchOutputContract {
  required_fields: string[];
  browser_evidence_required?: boolean;
}

export type DispatchTaskType =
  | 'analyze'
  | 'implement'
  | 'fix'
  | 'refactor'
  | 'test'
  | 'release'
  | 'research'
  | 'code';

export interface DispatchPayload {
  run_id: string;
  task_type: DispatchTaskType;
  input: string;
  repo: string;
  branch: string;
  acceptance_tests: string[];
  output_contract: DispatchOutputContract;
  priority?: 'low' | 'normal' | 'high';
  ui_impacting?: boolean;
}

export interface BrowserEvidence {
  base_url: string;
  tools_listed: string[];
  execute_tool_evidence: string[];
}

export interface CompletionContract {
  run_id?: string;
  branch: string;
  commit_sha: string;
  files_changed: string[];
  test_result: string;
  risk: string;
  pr_url?: string;
  pr_skipped_reason?: string;
  browser_evidence?: BrowserEvidence;
}

const RUN_ID_MAX_LENGTH = 64;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^jarvis-[A-Za-z0-9._/-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const ALLOWED_TASK_TYPES: Set<DispatchTaskType> = new Set([
  'analyze',
  'implement',
  'fix',
  'refactor',
  'test',
  'release',
  'research',
  'code',
]);
const UI_HINT_PATTERN = /\b(ui|frontend|dashboard|page|component|layout|css|style|browser|webmcp|chrome-devtools|visual|route|navigation)\b/i;
const LOCAL_BASE_URL_PATTERN = /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i;
const SCREENSHOT_PATTERN = /\b(screenshot|screen[\s-]?shot|take_screenshot|browser_take_screenshot|comet_screenshot|image analysis|analyze screenshot)\b/i;
const COMPLETION_REQUIRED_FIELDS = [
  'run_id',
  'branch',
  'commit_sha',
  'files_changed',
  'test_result',
  'risk',
];

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function hasScreenshotDirective(text: string): boolean {
  return SCREENSHOT_PATTERN.test(text);
}

/**
 * Parse worker dispatch payload from message content.
 * Accepts either a raw JSON object string or text wrapping a JSON object.
 */
export function parseDispatchPayload(content: string): DispatchPayload | null {
  const trimmed = content.trim();
  const direct = parseJsonObject(trimmed);
  if (direct && typeof direct.run_id === 'string') {
    return direct as unknown as DispatchPayload;
  }

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;

  const wrapped = parseJsonObject(content.slice(firstBrace, lastBrace + 1));
  if (wrapped && typeof wrapped.run_id === 'string') {
    return wrapped as unknown as DispatchPayload;
  }

  return null;
}

export function validateDispatchPayload(payload: DispatchPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (
    payload.ui_impacting !== undefined
    && typeof payload.ui_impacting !== 'boolean'
  ) {
    errors.push('ui_impacting must be a boolean when provided');
  }

  if (!payload.run_id || /\s/.test(payload.run_id)) {
    errors.push('run_id must be a non-empty string with no whitespace');
  } else if (payload.run_id.length > RUN_ID_MAX_LENGTH) {
    errors.push(`run_id must be ${RUN_ID_MAX_LENGTH} characters or fewer`);
  }

  if (!payload.task_type || !ALLOWED_TASK_TYPES.has(payload.task_type)) {
    errors.push(`task_type must be one of: ${Array.from(ALLOWED_TASK_TYPES).join(', ')}`);
  }

  if (!payload.input || !payload.input.trim()) {
    errors.push('input is required');
  } else if (hasScreenshotDirective(payload.input)) {
    errors.push('input must not request screenshot capture/analysis; use text-based browser evidence');
  }

  if (!payload.repo || !REPO_PATTERN.test(payload.repo)) {
    errors.push('repo must be in owner/repo format');
  }

  if (!payload.branch || !BRANCH_PATTERN.test(payload.branch)) {
    errors.push('branch must match jarvis-<feature>');
  }

  if (!Array.isArray(payload.acceptance_tests) || payload.acceptance_tests.length === 0) {
    errors.push('acceptance_tests must be a non-empty array');
  } else if (payload.acceptance_tests.some((test) => typeof test !== 'string' || !test.trim())) {
    errors.push('acceptance_tests entries must be non-empty strings');
  } else if (payload.acceptance_tests.some((test) => hasScreenshotDirective(test))) {
    errors.push('acceptance_tests must not include screenshot commands; use text-based checks');
  }

  if (!payload.output_contract || typeof payload.output_contract !== 'object') {
    errors.push('output_contract is required');
  } else {
    if (
      payload.output_contract.browser_evidence_required !== undefined
      && typeof payload.output_contract.browser_evidence_required !== 'boolean'
    ) {
      errors.push('output_contract.browser_evidence_required must be a boolean when provided');
    }

    const fields = payload.output_contract.required_fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      errors.push('output_contract.required_fields must be a non-empty array');
    } else {
      for (const required of COMPLETION_REQUIRED_FIELDS) {
        if (!fields.includes(required)) {
          errors.push(`output_contract.required_fields missing ${required}`);
        }
      }
      const hasPrUrl = fields.includes('pr_url');
      const hasPrSkipped = fields.includes('pr_skipped_reason');
      if (!hasPrUrl && !hasPrSkipped) {
        errors.push('output_contract.required_fields must include pr_url or pr_skipped_reason');
      }

      if (requiresBrowserEvidence(payload) && !fields.includes('browser_evidence')) {
        errors.push('output_contract.required_fields must include browser_evidence for UI-impacting tasks');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function requiresBrowserEvidence(payload: DispatchPayload): boolean {
  if (payload.output_contract?.browser_evidence_required === true) return true;
  if (payload.output_contract?.browser_evidence_required === false) return false;
  if (payload.ui_impacting !== undefined) return payload.ui_impacting;

  const acceptance = Array.isArray(payload.acceptance_tests)
    ? payload.acceptance_tests.join('\n')
    : '';
  const haystack = `${payload.input ?? ''}\n${acceptance}`;
  return UI_HINT_PATTERN.test(haystack);
}

/**
 * Scan worker output for a <completion>...</completion> block and parse the JSON inside.
 * Returns typed contract or null if no valid block found.
 */
export function parseCompletionContract(output: string): CompletionContract | null {
  const match = output.match(/<completion>([\s\S]*?)<\/completion>/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1].trim());
    if (obj && typeof obj === 'object') {
      return obj as CompletionContract;
    }
  } catch {
    // invalid JSON inside completion block
  }
  return null;
}

export function validateCompletionContract(
  contract: CompletionContract | null,
  options?: {
    expectedRunId?: string;
    requiredFields?: string[];
    browserEvidenceRequired?: boolean;
  },
): { valid: boolean; missing: string[] } {
  if (!contract) return { valid: false, missing: ['completion block'] };

  const missing: string[] = [];

  if (!contract.run_id) {
    missing.push('run_id');
  } else if (/\s/.test(contract.run_id) || contract.run_id.length > RUN_ID_MAX_LENGTH) {
    missing.push('run_id format');
  } else if (options?.expectedRunId && contract.run_id !== options.expectedRunId) {
    missing.push('run_id mismatch');
  }

  if (!contract.branch || !BRANCH_PATTERN.test(contract.branch)) missing.push('branch');
  if (!contract.commit_sha || !COMMIT_SHA_PATTERN.test(contract.commit_sha)) missing.push('commit_sha');

  if (!Array.isArray(contract.files_changed) || contract.files_changed.length === 0) {
    missing.push('files_changed');
  } else if (
    contract.files_changed.some(
      (item) => typeof item !== 'string' || !item.trim(),
    )
  ) {
    missing.push('files_changed format');
  }

  if (!contract.test_result || !contract.test_result.trim()) missing.push('test_result');
  if (!contract.risk || !contract.risk.trim()) missing.push('risk');
  if (!contract.pr_url && !contract.pr_skipped_reason) missing.push('pr_url or pr_skipped_reason');

  const browserEvidenceRequired = options?.browserEvidenceRequired
    ?? options?.requiredFields?.includes('browser_evidence')
    ?? false;
  if (browserEvidenceRequired) {
    const evidence = contract.browser_evidence;
    if (!evidence || typeof evidence !== 'object') {
      missing.push('browser_evidence');
    } else {
      if (!evidence.base_url || !LOCAL_BASE_URL_PATTERN.test(evidence.base_url)) {
        missing.push('browser_evidence.base_url');
      }
      if (
        !Array.isArray(evidence.tools_listed)
        || evidence.tools_listed.length === 0
        || evidence.tools_listed.some((item) => typeof item !== 'string' || !item.trim())
      ) {
        missing.push('browser_evidence.tools_listed');
      }
      if (
        !Array.isArray(evidence.execute_tool_evidence)
        || evidence.execute_tool_evidence.length === 0
        || evidence.execute_tool_evidence.some(
          (item) => typeof item !== 'string' || !item.trim(),
        )
      ) {
        missing.push('browser_evidence.execute_tool_evidence');
      } else if (evidence.execute_tool_evidence.some((item) => hasScreenshotDirective(item))) {
        missing.push('browser_evidence.no_screenshots');
      }
      if (evidence.tools_listed.some((item) => hasScreenshotDirective(item))) {
        missing.push('browser_evidence.no_screenshots');
      }
    }
  }

  return { valid: missing.length === 0, missing };
}
