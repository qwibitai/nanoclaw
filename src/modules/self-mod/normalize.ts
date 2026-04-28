/**
 * Defensive coercion for the MCP server `args` field.
 *
 * The MCP framework's input schema (`type: 'array', items: { type: 'string' }`)
 * does not strictly reject string inputs, and the LLM occasionally hands us a
 * JSON-encoded string instead of a real array. The TypeScript `as string[]`
 * casts elsewhere are compile-time only, so a malformed value passes through
 * to `container.json` and breaks every subsequent container start.
 *
 * Normalize at every hop: array → filtered array, JSON-encoded array string
 * → parsed array, plain string → single-element array, anything else → [].
 */
export function normalizeStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string');
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        // Fall through — treat as a single-element array below.
      }
    }
    return [v];
  }
  return [];
}
