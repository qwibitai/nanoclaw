import { describe, it, expect } from 'vitest';

import { parseWhatsAppMentions } from './whatsapp.js';

describe('parseWhatsAppMentions', () => {
  it('returns empty mentions for plain text', () => {
    const { text, mentions } = parseWhatsAppMentions('hello there');
    expect(text).toBe('hello there');
    expect(mentions).toEqual([]);
  });

  it('extracts a single @<digits> mention into a JID', () => {
    const { text, mentions } = parseWhatsAppMentions('hey @15551234567 you around?');
    expect(text).toBe('hey @15551234567 you around?');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('strips a leading + so the literal text matches the JID digits', () => {
    const { text, mentions } = parseWhatsAppMentions('ping @+15551234567 please');
    expect(text).toBe('ping @15551234567 please');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('matches a mention at the start of the string', () => {
    const { text, mentions } = parseWhatsAppMentions('@15551234567 hi');
    expect(text).toBe('@15551234567 hi');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('extracts multiple distinct mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('cc @15551234567 and @17775556666');
    expect(text).toBe('cc @15551234567 and @17775556666');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net', '17775556666@s.whatsapp.net']);
  });

  it('deduplicates repeated mentions of the same number', () => {
    const { mentions } = parseWhatsAppMentions('@15551234567 ping @15551234567 again');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('does not tag email-like patterns', () => {
    const { text, mentions } = parseWhatsAppMentions('write to test@1234567890.com');
    expect(text).toBe('write to test@1234567890.com');
    expect(mentions).toEqual([]);
  });

  it('does not tag sequences shorter than 5 digits', () => {
    const { text, mentions } = parseWhatsAppMentions('see issue @123 for details');
    expect(text).toBe('see issue @123 for details');
    expect(mentions).toEqual([]);
  });

  it('handles punctuation directly after the digits', () => {
    const { text, mentions } = parseWhatsAppMentions('thanks @15551234567!');
    expect(text).toBe('thanks @15551234567!');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('handles parenthesized mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('(@15551234567) wrote this');
    expect(text).toBe('(@15551234567) wrote this');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });
});
