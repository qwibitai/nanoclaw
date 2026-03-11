import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addMapping,
  anonymize,
  AnonymizeConfig,
  deanonymize,
  loadAnonymizeConfig,
} from './anonymize.js';

let tmpDir: string;

function cfgPath(name = 'test-group.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -- loadAnonymizeConfig --

describe('loadAnonymizeConfig', () => {
  it('returns null when file is missing', () => {
    expect(loadAnonymizeConfig('nonexistent', cfgPath())).toBeNull();
  });

  it('returns null when enabled is false', () => {
    const p = writeConfig({ enabled: false, mappings: { A: 'B' } });
    expect(loadAnonymizeConfig('g', p)).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ broken json');
    expect(loadAnonymizeConfig('g', p)).toBeNull();
  });

  it('returns null when mappings is missing', () => {
    const p = writeConfig({ enabled: true });
    expect(loadAnonymizeConfig('g', p)).toBeNull();
  });

  it('loads valid config', () => {
    const p = writeConfig({
      enabled: true,
      piiCheck: true,
      piiModel: 'llama3.2:3b',
      mappings: { Olivia: 'Luna' },
    });
    const cfg = loadAnonymizeConfig('g', p);
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.piiCheck).toBe(true);
    expect(cfg!.piiModel).toBe('llama3.2:3b');
    expect(cfg!.mappings).toEqual({ Olivia: 'Luna' });
  });

  it('rejects circular mappings (pseudonym is also a key)', () => {
    const p = writeConfig({
      enabled: true,
      mappings: { Olivia: 'Luna', Luna: 'Star' },
    });
    expect(loadAnonymizeConfig('g', p)).toBeNull();
  });

  it('defaults piiCheck to false and piiModel to undefined', () => {
    const p = writeConfig({ enabled: true, mappings: { A: 'B' } });
    const cfg = loadAnonymizeConfig('g', p);
    expect(cfg!.piiCheck).toBe(false);
    expect(cfg!.piiModel).toBeUndefined();
  });
});

// -- anonymize --

describe('anonymize', () => {
  const cfg: AnonymizeConfig = {
    enabled: true,
    mappings: {
      'Olivia Smith': 'Luna Green',
      Olivia: 'Luna',
      Simon: 'Alex',
    },
  };

  it('replaces a single mapping', () => {
    expect(anonymize('Hello Olivia!', cfg)).toBe('Hello Luna!');
  });

  it('replaces multiple mappings', () => {
    expect(anonymize('Olivia and Simon went out', cfg)).toBe(
      'Luna and Alex went out',
    );
  });

  it('replaces longest match first', () => {
    expect(anonymize('Olivia Smith is here', cfg)).toBe('Luna Green is here');
  });

  it('is case-insensitive', () => {
    expect(anonymize('OLIVIA said hello', cfg)).toBe('Luna said hello');
  });

  it('respects word boundaries — matches possessive', () => {
    expect(anonymize("Olivia's toy", cfg)).toBe("Luna's toy");
  });

  it('respects word boundaries — matches with comma', () => {
    expect(anonymize('Olivia, come here', cfg)).toBe('Luna, come here');
  });

  it('respects word boundaries — does NOT match inside a word', () => {
    expect(anonymize('OliviaExtra is here', cfg)).toBe('OliviaExtra is here');
  });

  it('handles multiple occurrences', () => {
    expect(anonymize('Olivia and Olivia', cfg)).toBe('Luna and Luna');
  });

  it('returns unchanged text when no mappings match', () => {
    expect(anonymize('Hello world', cfg)).toBe('Hello world');
  });

  it('handles empty mappings', () => {
    const empty: AnonymizeConfig = { enabled: true, mappings: {} };
    expect(anonymize('Hello Olivia', empty)).toBe('Hello Olivia');
  });

  it('handles multi-line text', () => {
    const text = 'Line 1: Olivia\nLine 2: Simon';
    expect(anonymize(text, cfg)).toBe('Line 1: Luna\nLine 2: Alex');
  });

  it('handles XML-formatted messages', () => {
    const xml = '<message sender="Simon" time="12:00">Hello Olivia</message>';
    expect(anonymize(xml, cfg)).toBe(
      '<message sender="Alex" time="12:00">Hello Luna</message>',
    );
  });
});

// -- deanonymize --

describe('deanonymize', () => {
  const cfg: AnonymizeConfig = {
    enabled: true,
    mappings: {
      'Olivia Smith': 'Luna Green',
      Olivia: 'Luna',
      Simon: 'Alex',
    },
  };

  it('reverses a single mapping', () => {
    expect(deanonymize('Hello Luna!', cfg)).toBe('Hello Olivia!');
  });

  it('reverses multiple mappings', () => {
    expect(deanonymize('Luna and Alex went out', cfg)).toBe(
      'Olivia and Simon went out',
    );
  });

  it('reverses longest match first', () => {
    expect(deanonymize('Luna Green is here', cfg)).toBe('Olivia Smith is here');
  });

  it('handles multiple occurrences', () => {
    expect(deanonymize('Luna and Luna', cfg)).toBe('Olivia and Olivia');
  });
});

// -- addMapping --

describe('addMapping', () => {
  it('adds a new entry to the config file', () => {
    const p = writeConfig({
      enabled: true,
      mappings: { Olivia: 'Luna' },
    });
    addMapping('g', 'Livvy', 'Lulu', p);
    const updated = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(updated.mappings.Livvy).toBe('Lulu');
    expect(updated.mappings.Olivia).toBe('Luna');
    expect(updated.enabled).toBe(true);
  });
});
