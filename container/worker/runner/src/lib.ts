export const DEFAULT_FALLBACK_MODELS = [
  'minimax/MiniMax-M2.5',
  'opencode/minimax-m2.5-free',
  'opencode/big-pickle',
  'opencode/kimi-k2.5-free',
];

export function parseMaybeJson(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export function parseEventLines(stdout: string): Record<string, unknown>[] {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    const normalized = line.startsWith('data:') ? line.slice(5).trim() : line;
    const parsed = parseMaybeJson(normalized);
    if (parsed) events.push(parsed);
  }
  return events;
}

export function getPayloadError(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (payload.type === 'error') {
    if (typeof payload.message === 'string') return payload.message;
    const error = payload.error as Record<string, unknown> | undefined;
    if (error && typeof error.message === 'string') return error.message;
    const data = error?.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === 'string') return data.message;
    return JSON.stringify(payload);
  }
  const error = payload.error as Record<string, unknown> | undefined;
  if (error && typeof error.message === 'string') return error.message;
  return null;
}

export function getOpencodeErrorMessage(
  events: Record<string, unknown>[],
  payload: Record<string, unknown> | null,
): string | null {
  for (const event of events) {
    const eventError = getPayloadError(event);
    if (eventError) return eventError;
  }
  return getPayloadError(payload);
}

export function isModelNotFound(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('model not found') || text.includes('unknown model');
}

function findCompletionBlock(text: string): string | null {
  if (!text.trim()) return null;
  const match = text.match(/<completion>[\s\S]*?<\/completion>/i);
  return match ? match[0].trim() : null;
}

function extractTextFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const chunks = value
      .map((item) => extractTextFromUnknown(item))
      .filter((item): item is string => !!item && !!item.trim());
    return chunks.length > 0 ? chunks.join('\n') : null;
  }

  const obj = value as Record<string, unknown>;

  if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.result === 'string') return obj.result;
  if (typeof obj.output === 'string') return obj.output;
  if (typeof obj.message === 'string') return obj.message;

  const nestedCandidates = [
    obj.message,
    obj.content,
    obj.part,
    obj.parts,
    obj.properties,
  ];
  for (const candidate of nestedCandidates) {
    const extracted = extractTextFromUnknown(candidate);
    if (extracted && extracted.trim()) return extracted;
  }

  return null;
}

function extractTextFromEvent(event: Record<string, unknown>): string | null {
  return extractTextFromUnknown(event);
}

export function extractResult(
  stdout: string,
  payload: Record<string, unknown> | null,
  events: Record<string, unknown>[],
): string {
  const stdoutTrimmed = stdout.trim();
  const completionFromStdout = findCompletionBlock(stdoutTrimmed);
  if (completionFromStdout) return completionFromStdout;

  const chunks: string[] = [];
  for (const event of events) {
    const text = extractTextFromEvent(event);
    if (text && text.trim()) chunks.push(text);
  }
  if (chunks.length > 0) {
    const merged = chunks.join('\n').trim();
    const completionFromChunks = findCompletionBlock(merged);
    if (completionFromChunks) return completionFromChunks;
    return merged;
  }

  if (payload) {
    const payloadCandidates = [
      payload.message,
      payload.content,
      payload.text,
      payload.output,
      payload.result,
    ];

    for (const candidate of payloadCandidates) {
      if (typeof candidate !== 'string') continue;
      const completion = findCompletionBlock(candidate);
      if (completion) return completion;
      if (candidate.trim()) return candidate;
    }
  }

  if (stdoutTrimmed) return stdoutTrimmed;
  if (payload) return JSON.stringify(payload);
  return '';
}

const COMPLETION_REQUIRED_FIELDS = [
  'run_id',
  'branch',
  'commit_sha',
  'files_changed',
  'test_result',
  'risk',
];

/**
 * Validate that the worker output contains a well-formed <completion> block.
 * Returns { valid, missing } so callers can decide whether to retry.
 */
export function hasValidCompletionBlock(output: string): { valid: boolean; missing: string[] } {
  const match = output.match(/<completion>([\s\S]*?)<\/completion>/i);
  if (!match) {
    return { valid: false, missing: ['completion block'] };
  }

  let contract: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      contract = parsed as Record<string, unknown>;
    }
  } catch {
    return { valid: false, missing: ['completion block (invalid JSON inside tags)'] };
  }

  if (!contract) {
    return { valid: false, missing: ['completion block (not a JSON object)'] };
  }

  const missing: string[] = [];

  for (const field of COMPLETION_REQUIRED_FIELDS) {
    const value = contract[field];
    if (field === 'files_changed') {
      if (!Array.isArray(value)) missing.push(field);
    } else if (!value || (typeof value === 'string' && !value.trim())) {
      missing.push(field);
    }
  }

  // branch must match jarvis-*
  if (contract.branch && typeof contract.branch === 'string' && !/^jarvis-/i.test(contract.branch)) {
    missing.push('branch (must match jarvis-*)');
  }

  // pr_url OR pr_skipped_reason required
  const hasPrUrl = typeof contract.pr_url === 'string' && contract.pr_url.trim().length > 0;
  const hasPrSkipped = typeof contract.pr_skipped_reason === 'string' && contract.pr_skipped_reason.trim().length > 0;
  if (!hasPrUrl && !hasPrSkipped) {
    missing.push('pr_url or pr_skipped_reason');
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Build a focused retry prompt asking the worker to emit a corrected completion block.
 */
export function buildReworkPrompt(
  prevOutput: string,
  runId: string,
  branch: string,
  missing: string[],
): string {
  return [
    '<previous_output>',
    prevOutput,
    '</previous_output>',
    '',
    'The runner validated your output and found missing or invalid fields in the completion block.',
    '',
    `Missing fields: ${missing.join(', ')}`,
    '',
    `Run ID: ${runId}`,
    `Branch: ${branch}`,
    '',
    'Output ONLY the corrected <completion>...</completion> block with ALL required fields filled in.',
    'Use the exact run_id and branch shown above.',
    'Get commit_sha with: git rev-parse HEAD (after any push).',
    'Do not repeat your previous work — just emit the corrected block.',
  ].join('\n');
}

export function buildModelCandidates(
  requestedModel?: string,
  workerModel?: string,
): string[] {
  const seen = new Set<string>();
  const values = [requestedModel, workerModel, ...DEFAULT_FALLBACK_MODELS];
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
