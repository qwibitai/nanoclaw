import { describe, it, expect } from 'vitest';

import {
  extractMarkdownTables,
  parseMarkdownTable,
  renderMonospace,
  wrapForDiscord,
  wrapInCodeFence,
  renderSlackBlock,
  selectSlackStrategy,
  transformTablesInText,
} from './table-renderer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIMPLE_TABLE = `| Name | Value |
|------|-------|
| Foo  | 42    |
| Bar  | 7     |`;

const RIGHT_ALIGN_TABLE = `| Item | Count |
|------|------:|
| A    | 100   |
| B    | 5     |`;

const CENTER_ALIGN_TABLE = `| Label |
|:-----:|
| Hello |`;

const WIDE_TABLE = `| Column1 | Column2 | Column3 |
|---------|---------|---------|
| ${'x'.repeat(40)} | normal | ${'y'.repeat(40)} |`;

// ---------------------------------------------------------------------------
// extractMarkdownTables
// ---------------------------------------------------------------------------

describe('extractMarkdownTables', () => {
  it('finds a single table', () => {
    const result = extractMarkdownTables(SIMPLE_TABLE);
    expect(result).toHaveLength(1);
    expect(result[0].raw).toContain('Name');
    expect(result[0].startIndex).toBe(0);
  });

  it('returns empty array when no table present', () => {
    expect(extractMarkdownTables('Just plain text')).toHaveLength(0);
    expect(extractMarkdownTables('')).toHaveLength(0);
  });

  it('returns empty array quickly when no pipe characters', () => {
    // Fast-path: no | in text → skip all scanning
    expect(extractMarkdownTables('No pipes here at all')).toHaveLength(0);
  });

  it('finds multiple tables separated by text', () => {
    const text = `${SIMPLE_TABLE}\n\nSome text in between\n\n${RIGHT_ALIGN_TABLE}`;
    const result = extractMarkdownTables(text);
    expect(result).toHaveLength(2);
  });

  it('handles table with leading and trailing pipes', () => {
    const result = extractMarkdownTables(SIMPLE_TABLE);
    expect(result[0].raw).toMatch(/^\|/);
  });

  it('does not match text without a separator row', () => {
    const nope = `| Name | Value |\n| Foo  | 42    |`;
    expect(extractMarkdownTables(nope)).toHaveLength(0);
  });

  it('skips tables inside fenced code blocks', () => {
    const text = '```\n' + SIMPLE_TABLE + '\n```';
    expect(extractMarkdownTables(text)).toHaveLength(0);
  });

  it('records startIndex and endIndex that splice correctly', () => {
    const prefix = 'Before\n';
    const suffix = '\nAfter';
    const text = prefix + SIMPLE_TABLE + suffix;
    const [loc] = extractMarkdownTables(text);
    expect(loc.startIndex).toBe(prefix.length);
    expect(text.slice(loc.startIndex, loc.endIndex)).toContain('Name');
    // Splice should reconstruct: prefix + replacement + suffix
    const spliced =
      text.slice(0, loc.startIndex) + '[TABLE]' + text.slice(loc.endIndex);
    expect(spliced).toBe(prefix + '[TABLE]' + suffix.trimStart());
  });

  it('handles table with no trailing newline', () => {
    const text = `| A |\n|---|\n| 1 |`;
    const result = extractMarkdownTables(text);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownTable
// ---------------------------------------------------------------------------

describe('parseMarkdownTable', () => {
  it('parses column labels and default left alignment', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE);
    expect(model).not.toBeNull();
    expect(model!.columns).toHaveLength(2);
    expect(model!.columns[0].label).toBe('Name');
    expect(model!.columns[0].align).toBe('left');
    expect(model!.columns[1].label).toBe('Value');
  });

  it('parses right alignment from ---:', () => {
    const model = parseMarkdownTable(RIGHT_ALIGN_TABLE);
    expect(model!.columns[1].align).toBe('right');
  });

  it('parses center alignment from :---:', () => {
    const model = parseMarkdownTable(CENTER_ALIGN_TABLE);
    expect(model!.columns[0].align).toBe('center');
  });

  it('generates keys from header labels', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE);
    expect(model!.columns[0].key).toBe('name');
    expect(model!.columns[1].key).toBe('value');
  });

  it('deduplicates column keys', () => {
    const dup = `| Name | Name |\n|------|------|\n| A    | B    |`;
    const model = parseMarkdownTable(dup);
    expect(model!.columns[0].key).toBe('name');
    expect(model!.columns[1].key).toBe('name_2');
  });

  it('pads rows shorter than column count', () => {
    const short = `| A | B |\n|---|---|\n| x |`;
    const model = parseMarkdownTable(short);
    expect(model!.rows[0]['b']).toBe('');
  });

  it('returns null for text with fewer than 2 lines', () => {
    expect(parseMarkdownTable('| A |')).toBeNull();
  });

  it('returns null when second line is not a separator', () => {
    expect(parseMarkdownTable('| A |\n| B |')).toBeNull();
  });

  it('parses empty cells as empty strings', () => {
    const table = `| A | B |\n|---|---|\n|   |   |`;
    const model = parseMarkdownTable(table);
    expect(model!.rows[0]['a']).toBe('');
    expect(model!.rows[0]['b']).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderMonospace
// ---------------------------------------------------------------------------

describe('renderMonospace', () => {
  it('renders a simple 2-column table', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const out = renderMonospace(model);
    expect(out).toContain('Name');
    expect(out).toContain('Foo');
    expect(out).toContain('Bar');
  });

  it('includes header row by default', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const out = renderMonospace(model);
    const lines = out.split('\n');
    expect(lines[0]).toContain('Name');
    expect(lines[1]).toMatch(/^-+/); // separator line
  });

  it('omits header when includeHeader=false', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const out = renderMonospace(model, { includeHeader: false });
    expect(out).not.toContain('Name');
  });

  it('truncates long cells with ellipsis when truncateCell=true', () => {
    const model = parseMarkdownTable(WIDE_TABLE)!;
    const out = renderMonospace(model, { maxColWidth: 10 });
    expect(out).toContain('\u2026');
  });

  it('does not truncate when truncateCell=false', () => {
    const model = parseMarkdownTable(WIDE_TABLE)!;
    const out = renderMonospace(model, {
      maxColWidth: 10,
      truncateCell: false,
    });
    // Cells are hard-capped at width when padding, but values are not truncated
    expect(out).toContain('x'.repeat(10));
  });

  it('auto right-aligns numeric columns', () => {
    const table = `| Item | Qty |\n|------|-----|\n| Foo  | 100 |\n| Bar  | 5   |`;
    const model = parseMarkdownTable(table)!;
    const out = renderMonospace(model);
    const lines = out.split('\n');
    // In a right-aligned column, '100' should be flush right and '5' should be padded on left
    const dataLines = lines.slice(2);
    const qtyIdx5 = dataLines.find((l) => l.includes('Bar'))!;
    const qtyIdx100 = dataLines.find((l) => l.includes('Foo'))!;
    expect(qtyIdx5.indexOf('5')).toBeGreaterThan(qtyIdx100.indexOf('1'));
  });

  it('respects maxRows and appends truncation notice', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const out = renderMonospace(model, { maxRows: 1 });
    expect(out).toContain('Foo');
    expect(out).not.toContain('Bar');
    expect(out).toContain('1 more row');
  });

  it('includes title when model has title', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    model.title = 'My Report';
    const out = renderMonospace(model);
    expect(out.split('\n')[0]).toBe('My Report');
  });

  it('handles a table with no data rows (header only)', () => {
    const table = `| A | B |\n|---|---|`;
    const model = parseMarkdownTable(table)!;
    const out = renderMonospace(model);
    expect(out).toContain('A');
    expect(out.split('\n')).toHaveLength(2); // header + separator
  });

  it('handles boolean cell values', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    model.rows = [{ name: true, value: false }];
    const out = renderMonospace(model);
    expect(out).toContain('true');
    expect(out).toContain('false');
  });

  it('separator row matches column width for right-aligned narrow columns', () => {
    // Right-aligned single-char column: separator must be exactly 1 char wide
    const table = `| N |\n|--:|\n| 5 |`;
    const model = parseMarkdownTable(table)!;
    const out = renderMonospace(model);
    const lines = out.split('\n');
    // Separator must equal the width of header/data cells (no extra ':' appended)
    expect(lines[1].trimEnd().length).toBe(lines[0].trimEnd().length);
  });

  it('separator row matches column width for center-aligned narrow columns', () => {
    // Center-aligned 1-char column: separator must be exactly 1 char wide
    const table = `| X |\n|:-:|\n| 5 |`;
    const model = parseMarkdownTable(table)!;
    const out = renderMonospace(model);
    const lines = out.split('\n');
    expect(lines[1].trimEnd().length).toBe(lines[0].trimEnd().length);
  });
});

// ---------------------------------------------------------------------------
// wrapInCodeFence / wrapForDiscord (deprecated alias)
// ---------------------------------------------------------------------------

describe('wrapInCodeFence', () => {
  it('wraps text in triple-backtick fence', () => {
    const out = wrapInCodeFence('hello');
    expect(out).toBe('```\nhello\n```');
  });

  it('handles text that already contains backtick sequences', () => {
    const out = wrapInCodeFence('a ` b');
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('wrapForDiscord is an alias for wrapInCodeFence', () => {
    expect(wrapForDiscord('test')).toBe(wrapInCodeFence('test'));
  });
});

// ---------------------------------------------------------------------------
// renderSlackBlock
// ---------------------------------------------------------------------------

describe('renderSlackBlock', () => {
  it('produces correct column_settings (align + is_wrapped, no title)', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const block = renderSlackBlock(model);
    expect(block.type).toBe('table');
    expect(block.column_settings).toHaveLength(2);
    // Official API schema: no title field in column_settings
    expect(block.column_settings[0]).toEqual({
      align: 'left',
      is_wrapped: false,
    });
    expect(block.column_settings[0]).not.toHaveProperty('title');
  });

  it('includes header labels as the first row', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const block = renderSlackBlock(model);
    // rows[0] = header, rows[1..] = data
    expect(block.rows[0][0]).toEqual({ type: 'raw_text', text: 'Name' });
    expect(block.rows[0][1]).toEqual({ type: 'raw_text', text: 'Value' });
  });

  it('produces raw_text cells for data rows', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const block = renderSlackBlock(model);
    // rows[1] is the first data row ('Foo', '42')
    expect(block.rows[1][0]).toEqual({ type: 'raw_text', text: 'Foo' });
    expect(block.rows[1][1]).toEqual({ type: 'raw_text', text: '42' });
  });

  it('rows is an array of arrays (not objects with cells property)', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const block = renderSlackBlock(model);
    expect(Array.isArray(block.rows[0])).toBe(true);
    expect(block.rows[0]).not.toHaveProperty('cells');
  });

  it('coerces null/undefined values to empty string', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    model.rows = [{ name: null, value: undefined }];
    const block = renderSlackBlock(model);
    // rows[0] = header, rows[1] = data
    expect(block.rows[1][0].text).toBe('');
    expect(block.rows[1][1].text).toBe('');
  });

  it('coerces boolean values to string', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    model.rows = [{ name: true, value: false }];
    const block = renderSlackBlock(model);
    expect(block.rows[1][0].text).toBe('true');
  });

  it('coerces object values via JSON.stringify', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    model.rows = [{ name: { x: 1 }, value: 42 }];
    const block = renderSlackBlock(model);
    expect(block.rows[1][0].text).toBe('{"x":1}');
  });

  it('respects maxRows option (excludes header from limit)', () => {
    const model = parseMarkdownTable(SIMPLE_TABLE)!;
    const block = renderSlackBlock(model, { maxRows: 1 });
    // rows[0] = header, rows[1] = first data row only
    expect(block.rows).toHaveLength(2);
    expect(block.rows[1][0].text).toBe('Foo');
  });

  it('enforces Slack max 20 column limit', () => {
    // Build a model with 25 columns
    const cols = Array.from({ length: 25 }, (_, i) => ({
      key: `c${i}`,
      label: `Col${i}`,
      align: 'left' as const,
    }));
    const model: import('./table-renderer.js').TableModel = {
      columns: cols,
      rows: [Object.fromEntries(cols.map((c) => [c.key, 'x']))],
    };
    const block = renderSlackBlock(model);
    expect(block.column_settings).toHaveLength(20);
    expect(block.rows[0]).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// selectSlackStrategy
// ---------------------------------------------------------------------------

describe('selectSlackStrategy', () => {
  it('returns "block" for a single small table', () => {
    expect(selectSlackStrategy(1, 100)).toBe('block');
  });

  it('returns "monospace" for multiple tables', () => {
    expect(selectSlackStrategy(2, 100)).toBe('monospace');
  });

  it('returns "monospace" when slackStrategy option is "monospace"', () => {
    expect(selectSlackStrategy(1, 100, { slackStrategy: 'monospace' })).toBe(
      'monospace',
    );
  });

  it('returns "monospace" when fallbackMode is "monospace"', () => {
    expect(selectSlackStrategy(1, 100, { fallbackMode: 'monospace' })).toBe(
      'monospace',
    );
  });

  it('returns "monospace" when table exceeds size budget', () => {
    expect(selectSlackStrategy(1, 3001)).toBe('monospace');
  });

  it('returns "block" when strategy is "auto" (default)', () => {
    expect(selectSlackStrategy(1, 2999, { slackStrategy: 'auto' })).toBe(
      'block',
    );
  });

  it('returns "block" when slackStrategy is explicitly "block"', () => {
    // Even with multiple tables or large size, explicit 'block' forces block strategy
    expect(selectSlackStrategy(5, 10000, { slackStrategy: 'block' })).toBe(
      'block',
    );
  });
});

// ---------------------------------------------------------------------------
// transformTablesInText
// ---------------------------------------------------------------------------

describe('transformTablesInText', () => {
  // Discord

  it('replaces a markdown table with a fenced code block on Discord', () => {
    const { text } = transformTablesInText('discord', SIMPLE_TABLE);
    expect(text.startsWith('```')).toBe(true);
    expect(text.endsWith('```')).toBe(true);
    expect(text).toContain('Name');
    expect(text).not.toMatch(/^\|/m);
  });

  it('replaces multiple tables on Discord', () => {
    const input = `${SIMPLE_TABLE}\n\nBetween\n\n${RIGHT_ALIGN_TABLE}`;
    const { text } = transformTablesInText('discord', input);
    expect(text.match(/```/g)?.length).toBeGreaterThanOrEqual(4); // 2 fences × 2 tables
  });

  it('returns text unchanged when no tables on Discord', () => {
    const plain = 'No tables here.';
    expect(transformTablesInText('discord', plain).text).toBe(plain);
  });

  it('preserves surrounding text when replacing table on Discord', () => {
    const input = `Before\n${SIMPLE_TABLE}\nAfter`;
    const { text } = transformTablesInText('discord', input);
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  it('does not return slackAttachmentBlocks on Discord', () => {
    const { slackAttachmentBlocks } = transformTablesInText(
      'discord',
      SIMPLE_TABLE,
    );
    expect(slackAttachmentBlocks).toBeUndefined();
  });

  // Slack — block strategy

  it('removes single table from text and returns slackAttachmentBlocks for Slack', () => {
    const input = `Here are results:\n\n${SIMPLE_TABLE}\n\nThanks`;
    const { text, slackAttachmentBlocks } = transformTablesInText(
      'slack',
      input,
    );
    expect(slackAttachmentBlocks).toHaveLength(1);
    expect(slackAttachmentBlocks![0].type).toBe('table');
    expect(text).not.toMatch(/^\|.*\|$/m);
    expect(text).toContain('Here are results');
    expect(text).toContain('Thanks');
  });

  it('returns a well-formed Slack block for a single table', () => {
    const { slackAttachmentBlocks } = transformTablesInText(
      'slack',
      SIMPLE_TABLE,
    );
    const block = slackAttachmentBlocks![0];
    // column_settings has align/is_wrapped (no title per API spec)
    expect(block.column_settings[0].align).toBe('left');
    // rows[0] = header, rows[1] = first data row
    expect(block.rows[0][0]).toEqual({ type: 'raw_text', text: 'Name' });
    expect(block.rows[1][0]).toEqual({ type: 'raw_text', text: 'Foo' });
  });

  // Slack — monospace fallback for multiple tables

  it('replaces all tables with monospace when multiple tables on Slack', () => {
    const input = `${SIMPLE_TABLE}\n\nSome text\n\n${RIGHT_ALIGN_TABLE}`;
    const { text, slackAttachmentBlocks } = transformTablesInText(
      'slack',
      input,
    );
    expect(slackAttachmentBlocks).toBeUndefined();
    expect(text.match(/```/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('uses monospace when slackStrategy forces it', () => {
    const { text, slackAttachmentBlocks } = transformTablesInText(
      'slack',
      SIMPLE_TABLE,
      {
        slackStrategy: 'monospace',
      },
    );
    expect(slackAttachmentBlocks).toBeUndefined();
    expect(text).toContain('```');
  });

  // Edge cases

  it('returns text unchanged when no tables on Slack', () => {
    const plain = 'Nothing here.';
    const { text, slackAttachmentBlocks } = transformTablesInText(
      'slack',
      plain,
    );
    expect(text).toBe(plain);
    expect(slackAttachmentBlocks).toBeUndefined();
  });

  it('handles header-only table (no data rows) on Discord', () => {
    const headerOnly = `| A | B |\n|---|---|`;
    const { text } = transformTablesInText('discord', headerOnly);
    expect(text).toContain('```');
    expect(text).toContain('A');
  });
});
