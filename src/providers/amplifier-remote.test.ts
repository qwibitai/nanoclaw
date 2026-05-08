import { describe, it, expect } from 'vitest';

import { __test } from './amplifier-remote.js';

const { parseCredsFile, FORWARDED_KEYS } = __test;

describe('amplifier-remote host config', () => {
  describe('parseCredsFile', () => {
    it('parses simple KEY=VALUE pairs', () => {
      const out = parseCredsFile('AMPLIFIERD_API_KEY=abc123\nAMPLIFIERD_BASE_URL=http://host:8410');
      expect(out).toEqual({
        AMPLIFIERD_API_KEY: 'abc123',
        AMPLIFIERD_BASE_URL: 'http://host:8410',
      });
    });

    it('strips surrounding double or single quotes', () => {
      const out = parseCredsFile(`A="quoted"\nB='single'\nC=bare`);
      expect(out).toEqual({ A: 'quoted', B: 'single', C: 'bare' });
    });

    it('skips blank lines and # comments', () => {
      const content = `
# header
AMPLIFIERD_API_KEY=k

# another comment
AMPLIFIERD_BASE_URL=http://h:1
`;
      expect(parseCredsFile(content)).toEqual({
        AMPLIFIERD_API_KEY: 'k',
        AMPLIFIERD_BASE_URL: 'http://h:1',
      });
    });

    it('drops keys with empty values', () => {
      const out = parseCredsFile('AMPLIFIERD_API_KEY=\nAMPLIFIERD_BASE_URL=http://h:1');
      expect(out).toEqual({ AMPLIFIERD_BASE_URL: 'http://h:1' });
    });

    it('only the first = splits — values containing = survive', () => {
      const out = parseCredsFile('AMPLIFIERD_API_KEY=a=b=c');
      expect(out).toEqual({ AMPLIFIERD_API_KEY: 'a=b=c' });
    });
  });

  describe('FORWARDED_KEYS', () => {
    it('exposes the seven expected env vars', () => {
      expect(FORWARDED_KEYS).toEqual([
        'AMPLIFIERD_API_KEY',
        'AMPLIFIERD_BASE_URL',
        'AMPLIFIERD_BUNDLE',
        'AMPLIFIERD_WORKING_DIR',
        'AMPLIFIERD_MAX_PROMPT_BYTES',
        'AMPLIFIERD_TIMEOUT_MS',
        'AMPLIFIERD_ATTACH_PULL_URL',
      ]);
    });
  });
});
