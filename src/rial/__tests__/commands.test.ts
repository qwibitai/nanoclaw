import { describe, expect, it } from 'vitest';

import { HELP_TEXT, parseCommand } from '../commands.js';

describe('parseCommand', () => {
  it('parses /link', () => {
    expect(parseCommand('/link')).toEqual({ kind: 'link' });
  });

  it('parses /link with surrounding whitespace', () => {
    expect(parseCommand('   /link   ')).toEqual({ kind: 'link' });
  });

  it('is case-insensitive on the verb', () => {
    expect(parseCommand('/LINK')).toEqual({ kind: 'link' });
    expect(parseCommand('/Help')).toEqual({ kind: 'help' });
    expect(parseCommand('/Status vfy_abc')).toEqual({
      kind: 'status',
      id: 'vfy_abc',
    });
  });

  it('parses /help', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
  });

  it('parses /status with an id', () => {
    expect(parseCommand('/status vfy_abc123')).toEqual({
      kind: 'status',
      id: 'vfy_abc123',
    });
  });

  it('parses /status and ignores trailing args', () => {
    expect(parseCommand('/status vfy_abc extra junk')).toEqual({
      kind: 'status',
      id: 'vfy_abc',
    });
  });

  it('treats /status without an id as unknown', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'unknown' });
    expect(parseCommand('/status   ')).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for empty / non-string / unrelated text', () => {
    expect(parseCommand('')).toEqual({ kind: 'unknown' });
    expect(parseCommand('   ')).toEqual({ kind: 'unknown' });
    expect(parseCommand('hello there')).toEqual({ kind: 'unknown' });
    expect(parseCommand('/unknown command')).toEqual({ kind: 'unknown' });
    expect(parseCommand(null as unknown as string)).toEqual({
      kind: 'unknown',
    });
    expect(parseCommand(undefined as unknown as string)).toEqual({
      kind: 'unknown',
    });
    expect(parseCommand(42 as unknown as string)).toEqual({ kind: 'unknown' });
  });

  it('does not match link prefixes that are not exactly /link', () => {
    expect(parseCommand('/links')).toEqual({ kind: 'unknown' });
    expect(parseCommand('/link foo')).toEqual({ kind: 'unknown' });
  });

  it('exposes a non-empty help text', () => {
    expect(HELP_TEXT.length).toBeGreaterThan(0);
    expect(HELP_TEXT).toContain('/link');
    expect(HELP_TEXT).toContain('/status');
    expect(HELP_TEXT).toContain('/help');
  });
});
