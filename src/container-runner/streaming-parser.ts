import {
  type ContainerOutput,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from './types.js';

/**
 * Rolling state for the streaming parser: chunks arrive at arbitrary
 * boundaries, so we keep whatever couldn't be parsed yet in `buffer`
 * and track the latest newSessionId seen across chunks.
 */
export interface StreamingParserState {
  buffer: string;
  newSessionId?: string;
}

export function createStreamingParserState(): StreamingParserState {
  return { buffer: '' };
}

export interface ChunkParseResult {
  /** Fully parsed ContainerOutput objects extracted from this chunk. */
  outputs: ContainerOutput[];
  /** JSON strings that couldn't be parsed, with the error message. */
  parseErrors: Array<{ jsonStr: string; error: string }>;
  /** True if any output was extracted (for idle-timer reset decisions). */
  hadOutput: boolean;
}

/**
 * Append `chunk` to the state's buffer and extract every complete
 * `OUTPUT_START_MARKER…OUTPUT_END_MARKER` pair. State is mutated in
 * place. Partial trailing markers stay in `buffer` for the next call.
 */
export function consumeChunk(
  state: StreamingParserState,
  chunk: string,
): ChunkParseResult {
  state.buffer += chunk;
  const outputs: ContainerOutput[] = [];
  const parseErrors: ChunkParseResult['parseErrors'] = [];

  let startIdx: number;
  while ((startIdx = state.buffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = state.buffer.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break; // incomplete pair

    const jsonStr = state.buffer
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    state.buffer = state.buffer.slice(endIdx + OUTPUT_END_MARKER.length);

    try {
      const parsed: ContainerOutput = JSON.parse(jsonStr);
      if (parsed.newSessionId) {
        state.newSessionId = parsed.newSessionId;
      }
      outputs.push(parsed);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      parseErrors.push({
        jsonStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { outputs, parseErrors, hadOutput: outputs.length > 0 };
}

/**
 * Parse a single already-accumulated stdout string and return the
 * last ContainerOutput it contains. Used by the "legacy mode" path
 * when no onOutput callback is provided, so the final buffered text
 * is parsed once on container exit.
 */
export function parseLastOutput(stdout: string): ContainerOutput {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    // Fallback: last non-empty line (backwards compatibility)
    const lines = stdout.trim().split('\n');
    jsonLine = lines[lines.length - 1];
  }

  return JSON.parse(jsonLine) as ContainerOutput;
}
