import { describe, expect, it } from 'vitest';

import { formatOutbound, stripInternalTags } from './router.js';

describe('stripInternalTags — balanced tags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('stripInternalTags — streaming / unclosed tags (issue #29)', () => {
  it('strips unclosed <internal> tag to end of string', () => {
    expect(stripInternalTags('hello <internal>thinking...')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <int', () => {
    expect(stripInternalTags('hello <int')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <intern', () => {
    expect(stripInternalTags('hello <intern')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <internal', () => {
    expect(stripInternalTags('hello <internal')).toBe('hello');
  });

  it('strips complete pair + trailing unclosed tag', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b')).toBe(
      'hello',
    );
  });

  it('returns empty string when text is only unclosed internal tag', () => {
    expect(stripInternalTags('<internal>only this')).toBe('');
  });
});

describe('stripInternalTags — non-matching text', () => {
  it('does not strip similar tags like <integer>', () => {
    expect(stripInternalTags('<integer>5</integer>')).toBe(
      '<integer>5</integer>',
    );
  });

  it('leaves normal text unchanged', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});
