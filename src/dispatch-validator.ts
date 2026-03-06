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

export type DispatchContextIntent = 'continue' | 'fresh';

export interface DispatchPayload {
  run_id: string;
  request_id: string;
  task_type: DispatchTaskType;
  context_intent: DispatchContextIntent;
  input: string;
  repo: string;
  base_branch?: string;
  branch: string;
  acceptance_tests: string[];
  output_contract: DispatchOutputContract;
  priority?: 'low' | 'normal' | 'high';
  ui_impacting?: boolean;
  session_id?: string;
  parent_run_id?: string;
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
  session_id?: string;
}

const RUN_ID_MAX_LENGTH = 64;
const SESSION_ID_MAX_LENGTH = 128;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const BRANCH_PATTERN = /^jarvis-[A-Za-z0-9._/-]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// Accept short SHA forms commonly used in logs/contracts (6-40 chars).
const COMMIT_SHA_PATTERN = /^[0-9a-f]{6,40}$/i;

const ALLOWED_TASK_TYPES = new Set<DispatchTaskType>([
  'analyze',
  'implement',
  'fix',
  'refactor',
  'test',
  'release',
  'research',
  'code',
]);

const LOCAL_BASE_URL_PATTERN = /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i;

const SCREENSHOT_PATTERN =
  /\b(screenshot|screen[\s-]?shot|take_screenshot|browser_take_screenshot|comet_screenshot|image analysis|analyze screenshot)\b/i;

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

export function validateDispatchPayload(payload: DispatchPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (
    payload.ui_impacting != null &&
    typeof payload.ui_impacting !== 'boolean'
  ) {
    errors.push('ui_impacting must be a boolean when provided');
  }

  if (!payload.run_id || /\s/.test(payload.run_id)) {
    errors.push('run_id must be a non-empty string with no whitespace');
  } else if (payload.run_id.length > RUN_ID_MAX_LENGTH) {
    errors.push(`run_id must be ${RUN_ID_MAX_LENGTH} characters or fewer`);
  }

  if (
    payload.request_id == null ||
    typeof payload.request_id !== 'string' ||
    !payload.request_id.trim()
  ) {
    errors.push('request_id is required for worker dispatch');
  } else if (
    /\s/.test(payload.request_id) ||
    payload.request_id.length > RUN_ID_MAX_LENGTH
  ) {
    errors.push(
      `request_id must have no whitespace and <= ${RUN_ID_MAX_LENGTH} chars`,
    );
  }

  if (!payload.task_type || !ALLOWED_TASK_TYPES.has(payload.task_type)) {
    errors.push(
      `task_type must be one of: ${Array.from(ALLOWED_TASK_TYPES).join(', ')}`,
    );
  }

  if (
    payload.context_intent !== 'continue' &&
    payload.context_intent !== 'fresh'
  ) {
    errors.push('context_intent must be either "continue" or "fresh"');
  }

  if (!payload.input || !payload.input.trim()) {
    errors.push('input is required');
  } else if (hasScreenshotDirective(payload.input)) {
    errors.push(
      'input must not request screenshot capture/analysis; use text-based browser evidence',
    );
  }

  if (!payload.repo || !REPO_PATTERN.test(payload.repo)) {
    errors.push('repo must be in owner/repo format');
  }

  if (
    payload.base_branch != null &&
    (typeof payload.base_branch !== 'string' ||
      !payload.base_branch.trim() ||
      /\s/.test(payload.base_branch) ||
      !BASE_BRANCH_PATTERN.test(payload.base_branch))
  ) {
    errors.push('base_branch must be a non-empty branch name when provided');
  }

  if (!payload.branch || !BRANCH_PATTERN.test(payload.branch)) {
    errors.push('branch must match jarvis-<feature>');
  }

  if (
    payload.session_id != null &&
    (typeof payload.session_id !== 'string' ||
      !payload.session_id.trim() ||
      /\s/.test(payload.session_id) ||
      payload.session_id.length > SESSION_ID_MAX_LENGTH ||
      !SESSION_ID_PATTERN.test(payload.session_id))
  ) {
    errors.push(
      'session_id must be a non-empty opaque id with no whitespace when provided',
    );
  }

  if (
    payload.parent_run_id != null &&
    (typeof payload.parent_run_id !== 'string' ||
      !payload.parent_run_id.trim() ||
      /\s/.test(payload.parent_run_id) ||
      payload.parent_run_id.length > RUN_ID_MAX_LENGTH)
  ) {
    errors.push(
      `parent_run_id must be a non-empty id with no whitespace and <= ${RUN_ID_MAX_LENGTH} chars when provided`,
    );
  }

  if (payload.context_intent === 'fresh' && payload.session_id) {
    errors.push(
      'session_id must not be provided when context_intent is "fresh"',
    );
  }

  if (
    !Array.isArray(payload.acceptance_tests) ||
    payload.acceptance_tests.length === 0
  ) {
    errors.push('acceptance_tests must be a non-empty array');
  } else if (
    payload.acceptance_tests.some(
      (test) => typeof test !== 'string' || !test.trim(),
    )
  ) {
    errors.push('acceptance_tests entries must be non-empty strings');
  } else if (
    payload.acceptance_tests.some((test) => hasScreenshotDirective(test))
  ) {
    errors.push(
      'acceptance_tests must not include screenshot commands; use text-based checks',
    );
  }

  if (!payload.output_contract || typeof payload.output_contract !== 'object') {
    errors.push('output_contract is required');
  } else {
    if (
      payload.output_contract.browser_evidence_required !== undefined &&
      typeof payload.output_contract.browser_evidence_required !== 'boolean'
    ) {
      errors.push(
        'output_contract.browser_evidence_required must be a boolean when provided',
      );
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
        errors.push(
          'output_contract.required_fields must include pr_url or pr_skipped_reason',
        );
      }

      if (
        payload.context_intent === 'continue' &&
        !fields.includes('session_id')
      ) {
        errors.push(
          'output_contract.required_fields must include session_id when context_intent is "continue"',
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function requiresBrowserEvidence(payload: DispatchPayload): boolean {
  return payload.output_contract?.browser_evidence_required === true;
}

/**
 * Scan worker output for a <completion>...</completion> block and parse the JSON inside.
 * Returns typed contract or null if no valid block found.
 *
 * Fallback hierarchy:
 * 1. <completion>...</completion> tag (primary, enforced by worker CLAUDE.md + pre-exit gate)
 *    — with escape decode for models that emit \\n / \\" inside the block
 * 2. Whole output as a quoted JSON string wrapping a completion tag (OpenCode encoding edge case)
 * 3. Fenced JSON block or direct bare JSON (for analyze/research tasks without code changes)
 */
export function parseCompletionContract(
  output: string,
): CompletionContract | null {
  const normalizeCompletionContract = (
    contract: CompletionContract,
  ): CompletionContract => {
    const normalized = { ...contract };

    if (
      !normalized.pr_url &&
      normalized.pr_skipped_reason !== undefined &&
      normalized.pr_skipped_reason !== null &&
      !`${normalized.pr_skipped_reason}`.trim()
    ) {
      normalized.pr_skipped_reason = 'PR creation not requested';
    }

    return normalized;
  };

  const parseObject = (raw: string): CompletionContract | null => {
    try {
      const obj = JSON.parse(raw.trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return normalizeCompletionContract(obj as CompletionContract);
      }
    } catch {
      // ignore parse errors
    }
    return null;
  };

  // Decode escaped text (e.g. \\n → \n, \\" → ") to handle OpenCode encoding edge cases.
  const decodeEscapedText = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // If the block is itself a JSON string, decode once.
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string' && parsed.trim()) {
        return parsed;
      }
    } catch {
      // continue
    }

    if (!/\\[nrt"\\]/.test(trimmed)) return null;

    const decoded = trimmed
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    return decoded.trim() && decoded !== trimmed ? decoded : null;
  };

  const parseObjectFlexible = (raw: string): CompletionContract | null => {
    const direct = parseObject(raw);
    if (direct) return direct;

    const decoded = decodeEscapedText(raw);
    if (decoded) {
      const decodedObj = parseObject(decoded);
      if (decodedObj) return decodedObj;
    }

    return null;
  };

  const parseLatestCompletionTag = (raw: string): CompletionContract | null => {
    const completionRegex = /<completion>([\s\S]*?)<\/completion>/gi;
    let latest: CompletionContract | null = null;
    let match: RegExpExecArray | null;

    while ((match = completionRegex.exec(raw)) !== null) {
      const parsed = parseObjectFlexible(match[1]);
      if (parsed) latest = parsed;
    }

    return latest;
  };

  // 1. Primary: <completion>...</completion> tag
  const parsedTagged = parseLatestCompletionTag(output);
  if (parsedTagged) return parsedTagged;

  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const directCandidate = fenced ? fenced[1].trim() : trimmed;

  // 2. Whole output as a quoted JSON string wrapping a completion tag
  const decodedDirect = decodeEscapedText(directCandidate);
  if (decodedDirect) {
    const parsedDecodedTagged = parseLatestCompletionTag(decodedDirect);
    if (parsedDecodedTagged) return parsedDecodedTagged;
  }

  // 3. Fenced JSON or direct bare JSON (analyze/research tasks)
  return parseObjectFlexible(directCandidate);
}

export function validateCompletionContract(
  contract: CompletionContract | null,
  options?: {
    expectedRunId?: string;
    expectedBranch?: string;
    requiredFields?: string[];
    browserEvidenceRequired?: boolean;
    allowNoCodeChanges?: boolean;
  },
): {
  valid: boolean;
  missing: string[];
} {
  // Automatically allow no-code when pr_skipped_reason is present
  const hasPrSkippedReason = contract?.pr_skipped_reason?.trim();
  const effectiveAllowNoCode =
    options?.allowNoCodeChanges === true || !!hasPrSkippedReason;

  if (!contract) return { valid: false, missing: ['completion block'] };

  const missing: string[] = [];

  if (!contract.run_id) {
    missing.push('run_id');
  } else if (
    /\s/.test(contract.run_id) ||
    contract.run_id.length > RUN_ID_MAX_LENGTH
  ) {
    missing.push('run_id format');
  } else if (
    options?.expectedRunId &&
    contract.run_id !== options.expectedRunId
  ) {
    missing.push('run_id mismatch');
  }

  const requiredFields = options?.requiredFields ?? COMPLETION_REQUIRED_FIELDS;
  const requireBranch = requiredFields.includes('branch');
  const requireCommitSha = requiredFields.includes('commit_sha');
  const requireFilesChanged = requiredFields.includes('files_changed');
  const requireSessionId = requiredFields.includes('session_id');

  if (
    requireBranch &&
    (!contract.branch || !BRANCH_PATTERN.test(contract.branch))
  ) {
    missing.push('branch');
  } else if (
    requireBranch &&
    options?.expectedBranch &&
    contract.branch !== options.expectedBranch
  ) {
    missing.push('branch mismatch');
  }

  if (requireCommitSha) {
    const commitSha = contract.commit_sha?.trim();

    // Accept empty string (no commit made) OR valid 40-char hex OR allowed placeholders
    const isValidEmpty = commitSha === '';
    const isValidHex = COMMIT_SHA_PATTERN.test(commitSha || '');
    const isAllowedPlaceholder =
      effectiveAllowNoCode &&
      !!commitSha &&
      /^(n\/a|na|none|no-commit)$/i.test(commitSha);

    if (!commitSha || (!isValidHex && !isAllowedPlaceholder && !isValidEmpty)) {
      // If pr_skipped_reason is present, accept any commit_sha (including empty or non-standard)
      if (hasPrSkippedReason || effectiveAllowNoCode) {
        // pr_skipped_reason present or no-code allowed - commit_sha doesn't matter
      } else if (!isValidHex && !isAllowedPlaceholder) {
        missing.push('commit_sha format');
      }
    }
  }

  if (requireFilesChanged) {
    const filesChanged = contract.files_changed;

    // Accept missing/null/undefined as empty array (no files changed)
    if (!Array.isArray(filesChanged)) {
      // If pr_skipped_reason present or no-code allowed, default to empty array
      if (hasPrSkippedReason || effectiveAllowNoCode) {
        // Accept missing files_changed when there's a skip reason
      } else {
        missing.push('files_changed');
      }
    } else if (filesChanged.length === 0) {
      // Empty array is valid - no files changed
    } else if (
      filesChanged.some((item) => typeof item !== 'string' || !item.trim())
    ) {
      missing.push('files_changed format');
    }
  }

  if (!contract.test_result || !contract.test_result.trim()) {
    missing.push('test_result');
  }
  if (!contract.risk || !contract.risk.trim()) {
    missing.push('risk');
  }
  if (!contract.pr_url && !contract.pr_skipped_reason) {
    missing.push('pr_url or pr_skipped_reason');
  }

  if (requireSessionId) {
    if (
      !contract.session_id ||
      !contract.session_id.trim() ||
      /\s/.test(contract.session_id) ||
      contract.session_id.length > SESSION_ID_MAX_LENGTH ||
      !SESSION_ID_PATTERN.test(contract.session_id)
    ) {
      missing.push('session_id');
    }
  }

  const browserEvidenceRequired =
    options?.browserEvidenceRequired ??
    options?.requiredFields?.includes('browser_evidence') ??
    false;

  if (browserEvidenceRequired) {
    const evidence = contract.browser_evidence;
    if (!evidence || typeof evidence !== 'object') {
      missing.push('browser_evidence');
    } else {
      if (
        !evidence.base_url ||
        !LOCAL_BASE_URL_PATTERN.test(evidence.base_url)
      ) {
        missing.push('browser_evidence.base_url');
      }
      if (
        !Array.isArray(evidence.tools_listed) ||
        evidence.tools_listed.length === 0 ||
        evidence.tools_listed.some(
          (item) => typeof item !== 'string' || !item.trim(),
        )
      ) {
        missing.push('browser_evidence.tools_listed');
      }
      if (
        !Array.isArray(evidence.execute_tool_evidence) ||
        evidence.execute_tool_evidence.length === 0 ||
        evidence.execute_tool_evidence.some(
          (item) => typeof item !== 'string' || !item.trim(),
        )
      ) {
        missing.push('browser_evidence.execute_tool_evidence');
      } else if (
        evidence.execute_tool_evidence.some((item) =>
          hasScreenshotDirective(item),
        )
      ) {
        missing.push('browser_evidence.no_screenshots');
      }

      if (evidence.tools_listed.some((item) => hasScreenshotDirective(item))) {
        missing.push('browser_evidence.no_screenshots');
      }
    }
  }

  return { valid: missing.length === 0, missing };
}
