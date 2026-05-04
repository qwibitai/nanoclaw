import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetAllowlistCache,
  isRialBusinessNumber,
  loadBusinessAllowlist,
  normalisePhone,
} from '../allowlist.js';

let tmpDir: string;
let allowlistPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rial-allowlist-'));
  allowlistPath = path.join(tmpDir, 'rial-business-allowlist.json');
  _resetAllowlistCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetAllowlistCache();
});

function write(entries: unknown): void {
  fs.writeFileSync(allowlistPath, JSON.stringify(entries));
}

describe('normalisePhone', () => {
  it('strips JID server suffixes', () => {
    expect(normalisePhone('5491155551234@s.whatsapp.net')).toBe(
      '+5491155551234',
    );
    expect(normalisePhone('5491155551234@c.us')).toBe('+5491155551234');
  });

  it('strips device suffixes from JIDs', () => {
    expect(normalisePhone('5491155551234:7@s.whatsapp.net')).toBe(
      '+5491155551234',
    );
  });

  it('handles E.164 input verbatim', () => {
    expect(normalisePhone('+5491155551234')).toBe('+5491155551234');
  });

  it('strips non-digit characters', () => {
    expect(normalisePhone('+54 (911) 5555-1234')).toBe('+5491155551234');
    expect(normalisePhone('wa:+5491155551234')).toBe('+5491155551234');
  });

  it('returns empty for unusable input', () => {
    expect(normalisePhone('')).toBe('');
    expect(normalisePhone('not a number')).toBe('');
  });
});

describe('loadBusinessAllowlist', () => {
  it('returns empty set when file is missing', () => {
    const phones = loadBusinessAllowlist(allowlistPath);
    expect(phones.size).toBe(0);
  });

  it('returns empty set on invalid JSON', () => {
    fs.writeFileSync(allowlistPath, 'not-json');
    const phones = loadBusinessAllowlist(allowlistPath);
    expect(phones.size).toBe(0);
  });

  it('returns empty set when JSON root is not an array', () => {
    fs.writeFileSync(allowlistPath, '{"wa_phone_e164":"+541234"}');
    const phones = loadBusinessAllowlist(allowlistPath);
    expect(phones.size).toBe(0);
  });

  it('loads valid entries and normalises phones', () => {
    write([
      { wa_phone_e164: '+5491155551234', label: 'demo' },
      { wa_phone_e164: '5491199998888@s.whatsapp.net' },
    ]);
    const phones = loadBusinessAllowlist(allowlistPath);
    expect(phones.has('+5491155551234')).toBe(true);
    expect(phones.has('+5491199998888')).toBe(true);
  });

  it('skips malformed entries', () => {
    write([
      { wa_phone_e164: '+5491155551234' },
      { label: 'no-phone' },
      'not-an-object',
      null,
      { wa_phone_e164: '' },
    ]);
    const phones = loadBusinessAllowlist(allowlistPath);
    expect(phones.size).toBe(1);
    expect(phones.has('+5491155551234')).toBe(true);
  });
});

describe('isRialBusinessNumber', () => {
  it('returns false when allowlist is empty', () => {
    expect(isRialBusinessNumber('+5491155551234', allowlistPath)).toBe(false);
  });

  it('matches by normalised phone', () => {
    write([{ wa_phone_e164: '+5491155551234' }]);
    _resetAllowlistCache();
    expect(isRialBusinessNumber('+5491155551234', allowlistPath)).toBe(true);
    expect(
      isRialBusinessNumber('5491155551234@s.whatsapp.net', allowlistPath),
    ).toBe(true);
    expect(
      isRialBusinessNumber('5491155551234:5@s.whatsapp.net', allowlistPath),
    ).toBe(true);
  });

  it('returns false for absent numbers', () => {
    write([{ wa_phone_e164: '+5491155551234' }]);
    _resetAllowlistCache();
    expect(isRialBusinessNumber('+5491100000000', allowlistPath)).toBe(false);
  });

  it('returns false for unparseable input', () => {
    write([{ wa_phone_e164: '+5491155551234' }]);
    _resetAllowlistCache();
    expect(isRialBusinessNumber('', allowlistPath)).toBe(false);
    expect(isRialBusinessNumber('garbage', allowlistPath)).toBe(false);
  });
});
