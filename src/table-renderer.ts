/**
 * Cross-platform table rendering for Discord and Slack.
 *
 * Entry point for channels: transformTablesInText()
 *   - Discord: replaces markdown tables with monospace code blocks inline
 *   - Slack:   single table → native Block Kit table in attachments
 *              multiple tables → monospace code blocks inline
 */

export interface TableColumn {
  key: string;
  label: string;
  align: 'left' | 'right' | 'center';
  maxWidth?: number;
}

export interface TableModel {
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  title?: string;
  caption?: string;
}

export interface TableRenderOptions {
  maxRows?: number;
  maxColWidth?: number;
  truncateCell?: boolean;
  includeHeader?: boolean;
  fallbackMode?: 'monospace';
  slackStrategy?: 'auto' | 'block' | 'monospace';
}

export type Platform = 'discord' | 'slack';

/**
 * Slack Block Kit table block (API released Aug 2025).
 * Must be placed in attachments[].blocks[], not top-level blocks.
 * Rows are arrays of arrays; header is the first row.
 * Ref: https://docs.slack.dev/reference/block-kit/blocks/table-block/
 */
export interface SlackTableBlock {
  type: 'table';
  column_settings: Array<{
    align?: 'left' | 'right' | 'center';
    is_wrapped?: boolean;
  }>;
  rows: Array<Array<{ type: 'raw_text'; text: string }>>;
}

interface ParsedTableLocation {
  raw: string;
  startIndex: number;
  endIndex: number;
}

const SLACK_MAX_ROWS = 100;
const SLACK_MAX_COLS = 20;

// ---------------------------------------------------------------------------
// Visual width helpers (CJK, emoji, zero-width character support)
// ---------------------------------------------------------------------------

/**
 * Computes the visual terminal width of a string, accounting for:
 * - Zero-width characters (combining marks, variation selectors, ZWS, BOM) → 0
 * - Wide characters (CJK, Hangul, fullwidth, emoji) → 2
 * - All others → 1
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const cp = char.codePointAt(0) ?? 0;
    // Zero-width: BOM, ZWS, ZWNJ, ZWJ, soft hyphen, combining marks, variation selectors
    if (
      cp === 0xfeff ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      cp === 0x00ad ||
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      continue;
    }
    // Wide (2 columns): CJK, Hangul, fullwidth, emoji
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303f) ||
      (cp >= 0x3040 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x2a6df)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function truncateStr(s: string, maxVisual: number): string {
  if (visualWidth(s) <= maxVisual) return s;
  let w = 0;
  let i = 0;
  for (const char of s) {
    const cw = visualWidth(char);
    if (w + cw > maxVisual - 1) break;
    w += cw;
    i += char.length;
  }
  return s.slice(0, i) + '\u2026';
}

function padCell(
  val: string,
  width: number,
  align: 'left' | 'right' | 'center',
): string {
  const vw = visualWidth(val);
  if (vw >= width) return val;
  const pad = width - vw;
  if (align === 'right') return ' '.repeat(pad) + val;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + val + ' '.repeat(pad - left);
  }
  return val + ' '.repeat(pad);
}

// ---------------------------------------------------------------------------
// Markdown table parsing
// ---------------------------------------------------------------------------

function splitCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

const SEP_CELL_RE = /^:?-+:?$/;

function isSeparatorLine(line: string): boolean {
  const cells = splitCells(line).map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => SEP_CELL_RE.test(c));
}

function cellAlign(sep: string): 'left' | 'right' | 'center' {
  const s = sep.trim();
  if (s.startsWith(':') && s.endsWith(':')) return 'center';
  if (s.endsWith(':')) return 'right';
  return 'left';
}

function labelToKey(label: string, idx: number): string {
  const key = label
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return key || `col_${idx}`;
}

function coerceToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

function isNumericLike(s: string): boolean {
  return s !== '' && !isNaN(Number(s));
}

// ---------------------------------------------------------------------------
// Public: table extraction and parsing
// ---------------------------------------------------------------------------

export function extractMarkdownTables(text: string): ParsedTableLocation[] {
  // Fast path: no pipe characters means no tables
  if (!text.includes('|')) return [];

  const lines = text.split('\n');
  const results: ParsedTableLocation[] = [];

  // Build a map of character offsets for each line start
  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1; // +1 for \n
  }

  let i = 0;
  let inCodeFence = false;
  while (i < lines.length) {
    const line = lines[i];

    // Track fenced code blocks — tables inside fences must not be extracted
    if (line.trimStart().startsWith('```')) {
      inCodeFence = !inCodeFence;
      i++;
      continue;
    }
    if (inCodeFence) {
      i++;
      continue;
    }

    if (!line.includes('|')) {
      i++;
      continue;
    }

    const next = lines[i + 1];
    if (!next || !next.includes('|') || !isSeparatorLine(next)) {
      i++;
      continue;
    }

    // Consume all consecutive pipe-containing lines after the separator
    let endLine = i + 1;
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|')) {
      endLine = j;
      j++;
    }

    const startIndex = lineStarts[i];
    const endCharOfLastLine = lineStarts[endLine] + lines[endLine].length;
    const endIndex =
      endCharOfLastLine < text.length && text[endCharOfLastLine] === '\n'
        ? endCharOfLastLine + 1
        : endCharOfLastLine;

    results.push({
      raw: text.slice(startIndex, endIndex),
      startIndex,
      endIndex,
    });
    i = endLine + 1;
  }

  return results;
}

export function parseMarkdownTable(raw: string): TableModel | null {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return null;
  if (!isSeparatorLine(lines[1])) return null;

  const headerCells = splitCells(lines[0]).map((c) => c.trim());
  const sepCells = splitCells(lines[1]).map((c) => c.trim());

  const usedKeys = new Set<string>();
  const columns: TableColumn[] = headerCells.map((label, idx) => {
    let key = labelToKey(label, idx);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}_${n}`)) n++;
      key = `${key}_${n}`;
    }
    usedKeys.add(key);
    return { key, label, align: cellAlign(sepCells[idx] ?? '') };
  });

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitCells(lines[i]).map((c) => c.trim());
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      row[col.key] = cells[idx] !== undefined ? cells[idx] : '';
    });
    rows.push(row);
  }

  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Public: rendering
// ---------------------------------------------------------------------------

export function renderMonospace(
  model: TableModel,
  opts: TableRenderOptions = {},
): string {
  const maxColWidth = opts.maxColWidth ?? 30;
  const shouldTruncate = opts.truncateCell !== false;
  const includeHeader = opts.includeHeader !== false;
  const { columns } = model;

  let rows = model.rows;
  let truncatedCount = 0;
  if (opts.maxRows !== undefined && rows.length > opts.maxRows) {
    truncatedCount = rows.length - opts.maxRows;
    rows = rows.slice(0, opts.maxRows);
  }

  // Auto-detect numeric columns for right-alignment
  const numericCol = columns.map(
    (col) =>
      rows.length > 0 &&
      rows.every((row) => {
        const val = coerceToString(row[col.key]);
        return val === '' || isNumericLike(val);
      }),
  );

  const effectiveAlign = columns.map((col, i): 'left' | 'right' | 'center' => {
    if (col.align !== 'left') return col.align;
    return numericCol[i] ? 'right' : 'left';
  });

  // Compute column widths from header labels and cell values
  const widths = columns.map((col) => {
    let w = visualWidth(col.label);
    for (const row of rows) {
      const val = coerceToString(row[col.key]);
      w = Math.max(w, Math.min(visualWidth(val), maxColWidth));
    }
    return Math.min(w, maxColWidth);
  });

  const output: string[] = [];
  if (model.title) output.push(model.title);

  if (includeHeader) {
    output.push(
      columns
        .map((col, i) => padCell(col.label, widths[i], effectiveAlign[i]))
        .join('  '),
    );
    output.push(
      columns
        .map((col, i) => {
          const w = widths[i];
          // Separator must be exactly w visual characters wide
          if (effectiveAlign[i] === 'center') {
            return w >= 2 ? ':' + '-'.repeat(Math.max(0, w - 2)) + ':' : ':';
          }
          if (effectiveAlign[i] === 'right') {
            return w >= 2 ? '-'.repeat(w - 1) + ':' : '-';
          }
          return '-'.repeat(w);
        })
        .join('  '),
    );
  }

  for (const row of rows) {
    const cells = columns.map((col, i) => {
      let val = coerceToString(row[col.key]);
      if (shouldTruncate && visualWidth(val) > widths[i])
        val = truncateStr(val, widths[i]);
      return padCell(val, widths[i], effectiveAlign[i]);
    });
    output.push(cells.join('  '));
  }

  if (truncatedCount > 0) output.push(`\u2026 (${truncatedCount} more rows)`);
  if (model.caption) output.push(model.caption);

  return output.join('\n');
}

/** Wraps text in a triple-backtick code fence (works for both Discord and Slack). */
export function wrapInCodeFence(text: string): string {
  return '```\n' + text + '\n```';
}

/** @deprecated Use wrapInCodeFence. Kept for backwards compatibility. */
export const wrapForDiscord = wrapInCodeFence;

export function renderSlackBlock(
  model: TableModel,
  opts: TableRenderOptions = {},
): SlackTableBlock {
  const columns = model.columns.slice(0, SLACK_MAX_COLS);
  let dataRows = model.rows;
  if (opts.maxRows !== undefined && dataRows.length > opts.maxRows) {
    dataRows = dataRows.slice(0, opts.maxRows);
  }
  // Reserve one row for the header within Slack's 100-row limit
  const maxData = SLACK_MAX_ROWS - 1;
  if (dataRows.length > maxData) {
    dataRows = dataRows.slice(0, maxData);
  }

  const toCell = (text: string): { type: 'raw_text'; text: string } => ({
    type: 'raw_text',
    text,
  });
  const headerRow = columns.map((col) => toCell(col.label));
  const dataRowsFormatted = dataRows.map((row) =>
    columns.map((col) => toCell(coerceToString(row[col.key]))),
  );

  return {
    type: 'table',
    column_settings: columns.map((col) => ({
      align: col.align,
      is_wrapped: false,
    })),
    rows: [headerRow, ...dataRowsFormatted],
  };
}

export function selectSlackStrategy(
  tableCount: number,
  totalRawChars: number,
  opts: TableRenderOptions = {},
): 'block' | 'monospace' {
  if (opts.slackStrategy === 'monospace' || opts.fallbackMode === 'monospace')
    return 'monospace';
  if (opts.slackStrategy === 'block') return 'block';
  if (tableCount === 1 && totalRawChars < 3000) return 'block';
  return 'monospace';
}

// ---------------------------------------------------------------------------
// Public: main entry point
// ---------------------------------------------------------------------------

/**
 * Transforms markdown tables in text for the target platform.
 *
 * Discord: replaces each table with a monospace code fence.
 * Slack (single small table): strips table from text, returns as Slack Block Kit attachment block.
 * Slack (multiple/large tables): replaces each table with a monospace code fence.
 *
 * Returns the transformed text and, for Slack block strategy, the attachment blocks to send.
 */
export function transformTablesInText(
  platform: Platform,
  text: string,
  opts: TableRenderOptions = {},
): { text: string; slackAttachmentBlocks?: SlackTableBlock[] } {
  const locations = extractMarkdownTables(text);
  if (locations.length === 0) return { text };

  if (platform === 'discord') {
    let result = text;
    let offset = 0;
    for (const loc of locations) {
      const model = parseMarkdownTable(loc.raw);
      if (!model) continue;
      const rendered = wrapInCodeFence(renderMonospace(model, opts));
      result =
        result.slice(0, loc.startIndex + offset) +
        rendered +
        result.slice(loc.endIndex + offset);
      offset += rendered.length - (loc.endIndex - loc.startIndex);
    }
    return { text: result };
  }

  // Slack
  const totalRawChars = locations.reduce((sum, l) => sum + l.raw.length, 0);
  const strategy = selectSlackStrategy(locations.length, totalRawChars, opts);

  if (strategy === 'block') {
    const loc = locations[0];
    const model = parseMarkdownTable(loc.raw);
    if (!model) {
      // Unparseable table — fall back to monospace
      return transformTablesInText(platform, text, {
        ...opts,
        slackStrategy: 'monospace',
      });
    }
    const block = renderSlackBlock(model, opts);
    const stripped = (
      text.slice(0, loc.startIndex) + text.slice(loc.endIndex)
    ).trim();
    return { text: stripped, slackAttachmentBlocks: [block] };
  }

  // Monospace fallback for Slack (multiple tables or oversized)
  let result = text;
  let offset = 0;
  for (const loc of locations) {
    const model = parseMarkdownTable(loc.raw);
    if (!model) continue;
    const rendered = wrapInCodeFence(renderMonospace(model, opts));
    result =
      result.slice(0, loc.startIndex + offset) +
      rendered +
      result.slice(loc.endIndex + offset);
    offset += rendered.length - (loc.endIndex - loc.startIndex);
  }
  return { text: result };
}
