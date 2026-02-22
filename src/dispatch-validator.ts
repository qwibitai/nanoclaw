export interface DispatchPayload {
  run_id: string;
  task_type?: 'code' | 'chat' | 'batch' | 'tool' | 'fix';
  input?: string;
  branch?: string;
  priority?: 'low' | 'normal' | 'high';
}

export interface CompletionContract {
  branch: string;
  pr_url?: string;
  pr_skipped_reason?: string;
  test_result: string;
  risk: string;
  commit_sha?: string;
}

/**
 * Look for the first JSON object in message content that has a run_id field.
 * Returns typed payload or null if not found.
 */
export function parseDispatchPayload(content: string): DispatchPayload | null {
  // Find all {...} blocks and check for run_id
  const jsonPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = jsonPattern.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj === 'object' && typeof obj.run_id === 'string') {
        return obj as DispatchPayload;
      }
    } catch {
      // not valid JSON, continue
    }
  }
  return null;
}

export function validateDispatchPayload(payload: DispatchPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload.run_id || /\s/.test(payload.run_id)) {
    errors.push('run_id must be a non-empty string with no whitespace');
  } else if (payload.run_id.length > 64) {
    errors.push('run_id must be 64 characters or fewer');
  }
  return { valid: errors.length === 0, errors };
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

export function validateCompletionContract(contract: CompletionContract | null): { valid: boolean; missing: string[] } {
  if (!contract) return { valid: false, missing: ['completion block'] };
  const missing: string[] = [];
  if (!contract.branch) missing.push('branch');
  if (!contract.test_result) missing.push('test_result');
  if (!contract.risk) missing.push('risk');
  if (!contract.pr_url && !contract.pr_skipped_reason) missing.push('pr_url or pr_skipped_reason');
  return { valid: missing.length === 0, missing };
}
