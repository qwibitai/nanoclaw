import { describe, expect, it } from 'vitest';

import {
  formatListResponse,
  formatLookupResponse,
  parseAnonIntent,
} from './anon-commands.js';

const mappings = { Olivia: 'Luna', Simon: 'Alex', Claire: 'Ember' };

describe('parseAnonIntent', () => {
  describe('list intent', () => {
    it.each([
      'list',
      'show all mappings',
      'show me the full table',
      'mappings',
      'list all',
    ])('parses "%s" as list', (text) => {
      expect(parseAnonIntent(text, mappings)).toEqual({ intent: 'list' });
    });
  });

  describe('lookup intent', () => {
    it('looks up a real name directly', () => {
      expect(parseAnonIntent('Claire', mappings)).toEqual({
        intent: 'lookup',
        name: 'Claire',
      });
    });

    it('looks up a pseudonym directly', () => {
      expect(parseAnonIntent('Luna', mappings)).toEqual({
        intent: 'lookup',
        name: 'Luna',
      });
    });

    it('handles natural phrasing: "who is Luna"', () => {
      expect(parseAnonIntent('who is Luna', mappings)).toEqual({
        intent: 'lookup',
        name: 'Luna',
      });
    });

    it('handles natural phrasing: "what\'s Olivia mapped to?"', () => {
      expect(parseAnonIntent("what's Olivia mapped to?", mappings)).toEqual({
        intent: 'lookup',
        name: 'Olivia',
      });
    });

    it('is case insensitive', () => {
      expect(parseAnonIntent('CLAIRE', mappings)).toEqual({
        intent: 'lookup',
        name: 'Claire',
      });
    });

    it('prefers lookup over list when a name is present with list keywords', () => {
      expect(parseAnonIntent('show me Claire', mappings)).toEqual({
        intent: 'lookup',
        name: 'Claire',
      });
    });
  });

  describe('add intent', () => {
    it('parses "add Claire as Ember"', () => {
      expect(parseAnonIntent('add Claire as Ember', {})).toEqual({
        intent: 'add',
        real: 'Claire',
        pseudonym: 'Ember',
      });
    });

    it('parses "map Rich to Azure"', () => {
      expect(parseAnonIntent('map Rich to Azure', {})).toEqual({
        intent: 'add',
        real: 'Rich',
        pseudonym: 'Azure',
      });
    });

    it('parses "Claire > Ember" (no keyword, just separator)', () => {
      expect(parseAnonIntent('Claire > Ember', {})).toEqual({
        intent: 'add',
        real: 'Claire',
        pseudonym: 'Ember',
      });
    });

    it('parses "set Hannah = Coral"', () => {
      expect(parseAnonIntent('set Hannah = Coral', {})).toEqual({
        intent: 'add',
        real: 'Hannah',
        pseudonym: 'Coral',
      });
    });

    it('parses "Rich → Azure"', () => {
      expect(parseAnonIntent('Rich → Azure', {})).toEqual({
        intent: 'add',
        real: 'Rich',
        pseudonym: 'Azure',
      });
    });
  });

  describe('remove intent', () => {
    it('parses "remove Claire"', () => {
      expect(parseAnonIntent('remove Claire', mappings)).toEqual({
        intent: 'remove',
        name: 'Claire',
      });
    });

    it('parses "delete the mapping for Rich"', () => {
      expect(parseAnonIntent('delete the mapping for Rich', mappings)).toEqual({
        intent: 'remove',
        name: 'Rich',
      });
    });

    it('parses "unmap Simon"', () => {
      expect(parseAnonIntent('unmap Simon', mappings)).toEqual({
        intent: 'remove',
        name: 'Simon',
      });
    });
  });

  describe('help intent', () => {
    it('returns help for empty text', () => {
      expect(parseAnonIntent('', mappings)).toEqual({ intent: 'help' });
    });

    it('returns help for "help"', () => {
      expect(parseAnonIntent('help', mappings)).toEqual({ intent: 'help' });
    });

    it('returns help for "?"', () => {
      expect(parseAnonIntent('?', mappings)).toEqual({ intent: 'help' });
    });

    it('returns help for unrecognised text', () => {
      expect(parseAnonIntent('blah blah', {})).toEqual({ intent: 'help' });
    });
  });
});

describe('formatListResponse', () => {
  it('formats multiple mappings', () => {
    const result = formatListResponse(
      { Olivia: 'Luna', Simon: 'Alex' },
      'olivia',
    );
    expect(result).toContain('Anonymisation mappings (olivia):');
    expect(result).toContain('Olivia → Luna');
    expect(result).toContain('Simon → Alex');
    expect(result).toContain('(2 mappings)');
  });

  it('formats single mapping with correct plural', () => {
    const result = formatListResponse({ Olivia: 'Luna' }, 'olivia');
    expect(result).toContain('(1 mapping)');
  });

  it('handles empty mappings', () => {
    const result = formatListResponse({}, 'olivia');
    expect(result).toContain('No anonymisation mappings');
  });
});

describe('formatLookupResponse', () => {
  it('looks up by real name', () => {
    expect(formatLookupResponse('Olivia', mappings)).toBe('Olivia → Luna');
  });

  it('looks up by pseudonym (reverse)', () => {
    expect(formatLookupResponse('Luna', mappings)).toBe('Luna ← Olivia');
  });

  it('is case insensitive', () => {
    expect(formatLookupResponse('olivia', mappings)).toBe('Olivia → Luna');
  });

  it('returns not found for unknown name', () => {
    expect(formatLookupResponse('Hannah', mappings)).toContain('not found');
  });
});
