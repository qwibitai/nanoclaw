import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';

import {
  writeMemoryEntry,
  readMemoryDomain,
  readAllMemory,
  categorizeContent,
  migrateFromSingleFile,
  DOMAINS,
} from './structured-memory.js';
import { resolveGroupFolderPath } from './group-folder.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('node:fs');
vi.mock('./group-folder.js');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();

  (resolveGroupFolderPath as Mock).mockImplementation(
    (folder: string) => `/tmp/test-groups/${folder}`,
  );

  (fs.existsSync as Mock).mockReturnValue(false);
  (fs.statSync as Mock).mockReturnValue({ size: 100 });
  (fs.readFileSync as Mock).mockReturnValue('');
  (fs.writeFileSync as Mock).mockImplementation(() => {});
  (fs.appendFileSync as Mock).mockImplementation(() => {});
  (fs.mkdirSync as Mock).mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// categorizeContent
// ---------------------------------------------------------------------------

describe('categorizeContent', () => {
  it('should categorize operational content', () => {
    expect(categorizeContent('Deploy the server to production, update the config')).toBe(
      'operational',
    );
  });

  it('should categorize people content', () => {
    expect(categorizeContent("Brandon prefers dark mode and his email is test@test.com")).toBe(
      'people',
    );
  });

  it('should categorize incidents content', () => {
    expect(categorizeContent('Server crashed at 3am, root cause was memory leak')).toBe(
      'incidents',
    );
  });

  it('should categorize decisions content', () => {
    expect(
      categorizeContent('We decided to go with PostgreSQL, the rationale was better JSON support'),
    ).toBe('decisions');
  });

  it('should default to operational for ambiguous content', () => {
    expect(categorizeContent('some random text with no keywords')).toBe('operational');
  });

  it('should handle empty string', () => {
    expect(categorizeContent('')).toBe('operational');
  });
});

// ---------------------------------------------------------------------------
// writeMemoryEntry
// ---------------------------------------------------------------------------

describe('writeMemoryEntry', () => {
  it('should write entry to correct domain file', async () => {
    const result = await writeMemoryEntry('main', {
      category: 'people',
      content: 'Brandon likes TypeScript',
      source: 'conversation',
      timestamp: '2026-02-28',
    });

    expect(result).toBe(true);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();

    const writePath = (fs.writeFileSync as Mock).mock.calls[0][0] as string;
    expect(writePath).toContain('people.md');

    const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
    expect(written).toContain('Brandon likes TypeScript');
    expect(written).toContain('# People');
  });

  it('should append to existing file', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.statSync as Mock).mockReturnValue({ size: 100 });

    const result = await writeMemoryEntry('main', {
      category: 'operational',
      content: 'Server runs on port 3000',
      source: 'observation',
      timestamp: '2026-02-28',
    });

    expect(result).toBe(true);
    expect(fs.appendFileSync).toHaveBeenCalled();
  });

  it('should reject invalid entries', async () => {
    const result = await writeMemoryEntry('main', {
      category: 'operational',
      content: '', // empty — fails min(1)
      source: 'test',
      timestamp: '2026-02-28',
    });

    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should scrub credentials from content', async () => {
    await writeMemoryEntry('main', {
      category: 'operational',
      content: 'API key is sk-secret-key-12345678',
      source: 'conversation',
      timestamp: '2026-02-28',
    });

    const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
    expect(written).not.toContain('sk-secret-key-12345678');
    expect(written).toContain('sk-***');
  });

  it('should skip when file exceeds 200KB', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.statSync as Mock).mockReturnValue({ size: 204800 });

    const result = await writeMemoryEntry('main', {
      category: 'people',
      content: 'Test entry',
      source: 'test',
      timestamp: '2026-02-28',
    });

    expect(result).toBe(false);
  });

  it('should truncate long content', async () => {
    const longContent = 'x'.repeat(10000);

    await writeMemoryEntry('main', {
      category: 'operational',
      content: longContent,
      source: 'test',
      timestamp: '2026-02-28',
    });

    const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
    // Should be truncated to MAX_ENTRY_LENGTH (5000) + header
    expect(written.length).toBeLessThan(longContent.length);
  });

  it('should include timestamp and source in markdown', async () => {
    await writeMemoryEntry('main', {
      category: 'decisions',
      content: 'Chose React over Vue',
      source: 'conversation',
      timestamp: '2026-02-28',
    });

    const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
    expect(written).toContain('2026-02-28');
    expect(written).toContain('conversation');
  });
});

// ---------------------------------------------------------------------------
// readMemoryDomain
// ---------------------------------------------------------------------------

describe('readMemoryDomain', () => {
  it('should read existing domain file', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('# People\n\nBrandon likes TS');

    const content = await readMemoryDomain('main', 'people');
    expect(content).toContain('Brandon likes TS');
  });

  it('should return empty string for missing domain file', async () => {
    (fs.existsSync as Mock).mockReturnValue(false);

    const content = await readMemoryDomain('main', 'incidents');
    expect(content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// readAllMemory
// ---------------------------------------------------------------------------

describe('readAllMemory', () => {
  it('should return all four domains', async () => {
    (fs.existsSync as Mock).mockReturnValue(false);

    const all = await readAllMemory('main');
    expect(Object.keys(all)).toEqual(
      expect.arrayContaining(['operational', 'people', 'incidents', 'decisions']),
    );
  });

  it('should return content for existing files', async () => {
    (fs.existsSync as Mock).mockImplementation((p: string) =>
      (p as string).includes('operational.md'),
    );
    (fs.readFileSync as Mock).mockReturnValue('# Ops\n\nServer config');

    const all = await readAllMemory('main');
    expect(all.operational).toContain('Server config');
    expect(all.people).toBe('');
  });
});

// ---------------------------------------------------------------------------
// migrateFromSingleFile
// ---------------------------------------------------------------------------

describe('migrateFromSingleFile', () => {
  it('should split content by sections and categorize', async () => {
    const singleFile = [
      '# Memory',
      '',
      '## Server Configuration',
      'Deploy on port 3000, restart with docker compose',
      '',
      '## Brandon Preferences',
      'Brandon prefers dark mode and his name is Brandon',
      '',
      '## Production Crash 2026-01',
      'Server crashed due to memory leak, root cause was unbounded array',
    ].join('\n');

    (fs.existsSync as Mock).mockImplementation((p: string) => {
      if ((p as string).includes('MEMORY.md')) return true;
      return false;
    });
    (fs.readFileSync as Mock).mockReturnValue(singleFile);

    const counts = await migrateFromSingleFile('main', '/tmp/MEMORY.md');

    expect(counts.operational).toBeGreaterThanOrEqual(1);
    expect(counts.people).toBeGreaterThanOrEqual(1);
    expect(counts.incidents).toBeGreaterThanOrEqual(1);
  });

  it('should return zeros for empty source file', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('');

    const counts = await migrateFromSingleFile('main', '/tmp/empty.md');

    expect(counts.operational).toBe(0);
    expect(counts.people).toBe(0);
    expect(counts.incidents).toBe(0);
    expect(counts.decisions).toBe(0);
  });

  it('should return zeros for missing source file', async () => {
    (fs.existsSync as Mock).mockReturnValue(false);

    const counts = await migrateFromSingleFile('main', '/tmp/missing.md');

    expect(counts.operational).toBe(0);
  });

  it('should not crash on error', async () => {
    (fs.existsSync as Mock).mockImplementation(() => {
      throw new Error('permission denied');
    });

    const counts = await migrateFromSingleFile('main', '/tmp/bad.md');
    expect(counts.operational).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DOMAINS constant
// ---------------------------------------------------------------------------

describe('DOMAINS', () => {
  it('should have exactly 4 domains', () => {
    expect(DOMAINS).toHaveLength(4);
  });

  it('should match MemoryEntrySchema categories', async () => {
    const { MemoryEntrySchema } = await import('./schemas.js');
    const schemaCategories = MemoryEntrySchema.shape.category.options;
    expect([...DOMAINS].sort()).toEqual([...schemaCategories].sort());
  });
});
