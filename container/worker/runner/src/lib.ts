export const DEFAULT_FALLBACK_MODELS = [
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

function extractTextFromEvent(event: Record<string, unknown>): string | null {
  if (event.type === 'text' && typeof event.text === 'string') return event.text;

  const part = event.part as Record<string, unknown> | undefined;
  if (part) {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (typeof part.text === 'string') return part.text;
  }

  const props = event.properties as Record<string, unknown> | undefined;
  const propPart = props?.part as Record<string, unknown> | undefined;
  if (propPart) {
    if (propPart.type === 'text' && typeof propPart.text === 'string') return propPart.text;
    if (typeof propPart.text === 'string') return propPart.text;
  }

  return null;
}

export function extractResult(
  stdout: string,
  payload: Record<string, unknown> | null,
  events: Record<string, unknown>[],
): string {
  const chunks: string[] = [];
  for (const event of events) {
    const text = extractTextFromEvent(event);
    if (text && text.trim()) chunks.push(text);
  }
  if (chunks.length > 0) return chunks.join('\n').trim();

  if (payload) {
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.content === 'string') return payload.content;
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.output === 'string') return payload.output;
    if (typeof payload.result === 'string') return payload.result;
    return JSON.stringify(payload);
  }
  return stdout.trim();
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
