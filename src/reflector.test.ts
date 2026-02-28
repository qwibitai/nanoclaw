import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';

import {
  parseObservationBlocks,
  filterBlocks,
  fileAgeDays,
  extractFileHeader,
  reassembleFile,
  reflectOnMemory,
} from './reflector.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

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
// Test data
// ---------------------------------------------------------------------------

const SAMPLE_FILE = [
  '<!-- source: observer -->',
  '## Observations \u2014 2026-01-15',
  '',
  '### 14:30 \u2014 Meeting discussion (\uD83D\uDD34 Critical)',
  '- Decided to move deployment to Friday',
  '- Action item for Brandon',
  'Referenced: 2026-01-15',
  '',
  '### 15:00 \u2014 Server health (\uD83D\uDFE2 Noise)',
  '- All systems nominal',
  'Referenced: 2026-01-15',
  '',
  '### 16:45 \u2014 Feature planning (\uD83D\uDFE1 Useful)',
  '- Discussed new auth flow',
  '- Need to research OAuth options',
  'Referenced: 2026-01-15',
].join('\n');

// ---------------------------------------------------------------------------
// parseObservationBlocks
// ---------------------------------------------------------------------------

describe('parseObservationBlocks', () => {
  it('should parse all three observation blocks', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    expect(blocks).toHaveLength(3);
  });

  it('should detect critical priority', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    expect(blocks[0].priority).toBe('critical');
    expect(blocks[0].header).toContain('Meeting discussion');
  });

  it('should detect noise priority', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    expect(blocks[1].priority).toBe('noise');
    expect(blocks[1].header).toContain('Server health');
  });

  it('should detect useful priority', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    expect(blocks[2].priority).toBe('useful');
    expect(blocks[2].header).toContain('Feature planning');
  });

  it('should extract body with points and references', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    expect(blocks[0].body).toContain('Decided to move deployment');
    expect(blocks[0].body).toContain('Referenced: 2026-01-15');
  });

  it('should return empty array for non-observation content', () => {
    const blocks = parseObservationBlocks('Just some random text\nNo headings');
    expect(blocks).toHaveLength(0);
  });

  it('should default unknown priority to useful', () => {
    const content = '### 10:00 \u2014 Unknown (\u2754 Mystery)\n- Something';
    const blocks = parseObservationBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].priority).toBe('useful');
  });
});

// ---------------------------------------------------------------------------
// fileAgeDays
// ---------------------------------------------------------------------------

describe('fileAgeDays', () => {
  it('should compute correct age for past dates', () => {
    const now = new Date('2026-02-28T12:00:00Z');
    expect(fileAgeDays('2026-02-27', now)).toBe(1);
    expect(fileAgeDays('2026-01-29', now)).toBe(30);
    expect(fileAgeDays('2025-12-01', now)).toBe(89);
  });

  it('should return 0 for today', () => {
    const now = new Date('2026-02-28T12:00:00Z');
    expect(fileAgeDays('2026-02-28', now)).toBe(0);
  });

  it('should return 0 for unparseable dates (safe default)', () => {
    const now = new Date('2026-02-28T12:00:00Z');
    expect(fileAgeDays('not-a-date', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterBlocks
// ---------------------------------------------------------------------------

describe('filterBlocks', () => {
  const blocks = parseObservationBlocks(SAMPLE_FILE);

  it('should keep all blocks when file is recent', () => {
    const result = filterBlocks(blocks, 5, {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 90,
    });
    expect(result.keep).toHaveLength(3);
    expect(result.pruned).toHaveLength(0);
  });

  it('should prune noise after 30 days', () => {
    const result = filterBlocks(blocks, 35, {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 90,
    });
    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].priority).toBe('noise');
    expect(result.keep).toHaveLength(2);
  });

  it('should prune noise and useful after 90 days', () => {
    const result = filterBlocks(blocks, 95, {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 90,
    });
    expect(result.pruned).toHaveLength(2);
    expect(result.keep).toHaveLength(1);
    expect(result.keep[0].priority).toBe('critical');
  });

  it('should never prune critical entries', () => {
    const result = filterBlocks(blocks, 9999, {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 90,
    });
    expect(result.keep).toHaveLength(1);
    expect(result.keep[0].priority).toBe('critical');
  });

  it('should respect custom policy thresholds', () => {
    const result = filterBlocks(blocks, 10, {
      noiseMaxAgeDays: 5,
      usefulMaxAgeDays: 5,
    });
    expect(result.pruned).toHaveLength(2); // noise + useful
    expect(result.keep).toHaveLength(1); // critical only
  });
});

// ---------------------------------------------------------------------------
// extractFileHeader
// ---------------------------------------------------------------------------

describe('extractFileHeader', () => {
  it('should extract header before first observation block', () => {
    const header = extractFileHeader(SAMPLE_FILE);
    expect(header).toContain('<!-- source: observer -->');
    expect(header).toContain('Observations');
    expect(header).not.toContain('### ');
  });

  it('should handle file with no header', () => {
    const header = extractFileHeader('### 10:00 \u2014 Topic\n- point');
    expect(header).toBe('');
  });
});

// ---------------------------------------------------------------------------
// reassembleFile
// ---------------------------------------------------------------------------

describe('reassembleFile', () => {
  it('should produce valid markdown with header and blocks', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    const header = extractFileHeader(SAMPLE_FILE);
    const result = reassembleFile(header, blocks);

    expect(result).toContain('<!-- source: observer -->');
    expect(result).toContain('Meeting discussion');
    expect(result).toContain('Server health');
    expect(result).toContain('Feature planning');
  });

  it('should return empty string when no blocks remain', () => {
    const result = reassembleFile('header', []);
    expect(result).toBe('');
  });

  it('should produce parseable output (roundtrip)', () => {
    const blocks = parseObservationBlocks(SAMPLE_FILE);
    const header = extractFileHeader(SAMPLE_FILE);
    const reassembled = reassembleFile(header, blocks);
    const reparsed = parseObservationBlocks(reassembled);
    expect(reparsed).toHaveLength(3);
    expect(reparsed[0].priority).toBe('critical');
    expect(reparsed[1].priority).toBe('noise');
    expect(reparsed[2].priority).toBe('useful');
  });
});

// ---------------------------------------------------------------------------
// reflectOnMemory — integration tests
// ---------------------------------------------------------------------------

describe('reflectOnMemory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    (resolveGroupFolderPath as Mock).mockImplementation(
      (folder: string) => `/tmp/test-groups/${folder}`,
    );
  });

  it('should return early when observer directory does not exist', async () => {
    (fs.existsSync as Mock).mockReturnValue(false);

    const result = await reflectOnMemory('main');

    expect(result.actions).toHaveLength(0);
    expect(result.summary).toContain('No observer data');
  });

  it('should return early when no .md files exist', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);

    const result = await reflectOnMemory('main');

    expect(result.summary).toContain('No observer files');
  });

  it('should prune noise entries from old files', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue(['2025-12-01.md']);
    (fs.readFileSync as Mock).mockReturnValue(SAMPLE_FILE);
    (fs.writeFileSync as Mock).mockImplementation(() => {});
    (fs.unlinkSync as Mock).mockImplementation(() => {});

    const result = await reflectOnMemory('main', {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 90,
    });

    // File is ~89 days old (from 2025-12-01 to ~2026-02-28)
    // Noise should be pruned, useful should be pruned (89 < 90 but close),
    // critical should stay
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.summary).toContain('Pruned');
  });

  it('should delete file when all entries are pruned', async () => {
    // File with only noise entries
    const noiseOnly = [
      '<!-- source: observer -->',
      '## Observations \u2014 2025-01-01',
      '',
      '### 10:00 \u2014 Check (\uD83D\uDFE2 Noise)',
      '- All good',
      'Referenced: 2025-01-01',
    ].join('\n');

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue(['2025-01-01.md']);
    (fs.readFileSync as Mock).mockReturnValue(noiseOnly);
    (fs.unlinkSync as Mock).mockImplementation(() => {});

    const result = await reflectOnMemory('main', { noiseMaxAgeDays: 30 });

    expect(fs.unlinkSync).toHaveBeenCalled();
    expect(result.actions.some((a) => a.reason.includes('file deleted'))).toBe(true);
  });

  it('should rewrite file when some entries remain', async () => {
    // File old enough that noise is pruned but critical stays
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue(['2025-12-01.md']);
    (fs.readFileSync as Mock).mockReturnValue(SAMPLE_FILE);
    (fs.writeFileSync as Mock).mockImplementation(() => {});

    await reflectOnMemory('main', {
      noiseMaxAgeDays: 30,
      usefulMaxAgeDays: 30,
    });

    // Should rewrite (not delete) because critical entry remains
    expect(fs.writeFileSync).toHaveBeenCalled();
    const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
    expect(written).toContain('Meeting discussion');
    expect(written).not.toContain('Server health'); // noise pruned
    expect(written).not.toContain('Feature planning'); // useful pruned
  });

  it('should skip recent files', async () => {
    const today = new Date().toISOString().split('T')[0];

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([`${today}.md`]);
    (fs.readFileSync as Mock).mockReturnValue(SAMPLE_FILE);

    const result = await reflectOnMemory('main');

    // Today's file — nothing should be pruned
    expect(result.actions).toHaveLength(0);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('should handle multiple files', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([
      '2025-01-01.md',
      '2025-06-15.md',
    ]);
    (fs.readFileSync as Mock).mockReturnValue(SAMPLE_FILE);
    (fs.writeFileSync as Mock).mockImplementation(() => {});
    (fs.unlinkSync as Mock).mockImplementation(() => {});

    const result = await reflectOnMemory('main');

    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('should return ReflectorOutput conforming to schema', async () => {
    const { ReflectorOutputSchema } = await import('./schemas.js');

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue(['2025-01-01.md']);
    (fs.readFileSync as Mock).mockReturnValue(SAMPLE_FILE);
    (fs.writeFileSync as Mock).mockImplementation(() => {});
    (fs.unlinkSync as Mock).mockImplementation(() => {});

    const result = await reflectOnMemory('main');
    const parsed = ReflectorOutputSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it('should handle read errors gracefully', async () => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue(['2025-01-01.md']);
    (fs.readFileSync as Mock).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await reflectOnMemory('main');

    // Should not crash, just skip the file
    expect(result.summary).toContain('No entries');
  });

  it('should use resolveGroupFolderPath', async () => {
    (fs.existsSync as Mock).mockReturnValue(false);

    await reflectOnMemory('test-group');

    expect(resolveGroupFolderPath).toHaveBeenCalledWith('test-group');
  });
});
