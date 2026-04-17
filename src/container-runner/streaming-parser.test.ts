import { describe, expect, it } from 'vitest';

import {
  consumeChunk,
  createStreamingParserState,
  parseLastOutput,
} from './streaming-parser.js';
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './types.js';

function wrap(payload: object): string {
  return `${OUTPUT_START_MARKER}\n${JSON.stringify(payload)}\n${OUTPUT_END_MARKER}\n`;
}

describe('consumeChunk', () => {
  it('extracts a single complete output from one chunk', () => {
    const state = createStreamingParserState();
    const { outputs, parseErrors, hadOutput } = consumeChunk(
      state,
      wrap({ status: 'success', result: 'hi' }),
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe('hi');
    expect(parseErrors).toHaveLength(0);
    expect(hadOutput).toBe(true);
  });

  it('reassembles a marker split across two chunks', () => {
    const state = createStreamingParserState();
    const payload = wrap({ status: 'success', result: 'chunked' });
    const mid = Math.floor(payload.length / 2);
    const first = consumeChunk(state, payload.slice(0, mid));
    expect(first.outputs).toHaveLength(0);
    const second = consumeChunk(state, payload.slice(mid));
    expect(second.outputs).toHaveLength(1);
    expect(second.outputs[0].result).toBe('chunked');
  });

  it('extracts multiple outputs from a single chunk', () => {
    const state = createStreamingParserState();
    const { outputs } = consumeChunk(
      state,
      wrap({ status: 'success', result: 'a' }) +
        wrap({ status: 'success', result: 'b' }),
    );
    expect(outputs.map((o) => o.result)).toEqual(['a', 'b']);
  });

  it('remembers newSessionId across calls', () => {
    const state = createStreamingParserState();
    consumeChunk(
      state,
      wrap({ status: 'success', result: null, newSessionId: 'sess-1' }),
    );
    expect(state.newSessionId).toBe('sess-1');
    // A later output without newSessionId doesn't clear it
    consumeChunk(state, wrap({ status: 'success', result: 'ok' }));
    expect(state.newSessionId).toBe('sess-1');
    // A later output with a new one updates it
    consumeChunk(
      state,
      wrap({ status: 'success', result: null, newSessionId: 'sess-2' }),
    );
    expect(state.newSessionId).toBe('sess-2');
  });

  it('keeps a trailing incomplete marker in the buffer', () => {
    const state = createStreamingParserState();
    consumeChunk(state, `${OUTPUT_START_MARKER}\n{"status":"succ`);
    expect(state.buffer).toContain(OUTPUT_START_MARKER);
    // Next chunk completes it
    const { outputs } = consumeChunk(
      state,
      `ess","result":"done"}\n${OUTPUT_END_MARKER}\n`,
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe('done');
  });

  it('reports parse errors without aborting the stream', () => {
    const state = createStreamingParserState();
    const { outputs, parseErrors } = consumeChunk(
      state,
      `${OUTPUT_START_MARKER}\n{ bad json }\n${OUTPUT_END_MARKER}\n` +
        wrap({ status: 'success', result: 'ok' }),
    );
    expect(parseErrors).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe('ok');
  });

  it('hadOutput is false when nothing was extracted', () => {
    const state = createStreamingParserState();
    const r = consumeChunk(state, 'random stderr-looking text\n');
    expect(r.hadOutput).toBe(false);
    expect(r.outputs).toHaveLength(0);
  });
});

describe('parseLastOutput', () => {
  it('returns the payload between the first marker pair', () => {
    const stdout =
      'pre noise\n' +
      wrap({ status: 'success', result: 'final' }) +
      'post noise\n';
    expect(parseLastOutput(stdout).result).toBe('final');
  });

  it('falls back to the last non-empty line when no markers present', () => {
    const stdout = 'first line\n{"status":"success","result":"legacy"}\n';
    expect(parseLastOutput(stdout).result).toBe('legacy');
  });

  it('throws when the fallback line is not JSON', () => {
    expect(() => parseLastOutput('not json at all\n')).toThrow();
  });
});
