/**
 * NanoClaw brand palette for the terminal.
 *
 * Colors pulled from assets/nanoclaw-logo.png:
 *   brand cyan  ≈ #2BB7CE  — the "Claw" wordmark + mascot body
 *   brand navy  ≈ #171B3B  — the dark logo background + outlines
 *
 * Rendering gates:
 *   - No TTY (piped / redirected) → plain text, no ANSI
 *   - NO_COLOR set               → plain text, no ANSI
 *   - COLORTERM truecolor/24bit  → 24-bit ANSI (exact brand cyan)
 *   - Otherwise                  → kleur's 16-color cyan (closest fallback)
 */
import k from 'kleur';

const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

export function brand(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
}

export function brandBold(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
}

export function brandChip(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${s}\x1b[0m`;
  }
  return k.bgCyan(k.black(k.bold(s)));
}

/**
 * Wrap text so it fits inside clack's gutter without the terminal's soft
 * wrap breaking the `│ …` bar on long lines. Works on a single string with
 * embedded `\n`s; each logical line is wrapped independently.
 *
 * The `gutter` argument is the total horizontal overhead clack adds for
 * the component the text lives in (e.g. 4 for `p.log.*`'s `│  ` prefix;
 * 6-ish for `p.note`'s box). Caller picks it; we just subtract from
 * `process.stdout.columns` and hard-wrap at word boundaries.
 */
export function wrapForGutter(text: string, gutter: number): string {
  const cols = process.stdout.columns ?? 80;
  const width = Math.max(30, cols - gutter);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

/**
 * Wrap multi-line explanatory prose to the clack gutter. Previously
 * dimmed its output (hence the name) — that made body copy hard to read
 * against dark terminals. Dim is now reserved for preview/debug blocks
 * (failure transcript tails, claude-assist streams); prose renders at
 * the terminal's regular weight.
 */
export function dimWrap(text: string, gutter: number): string {
  return wrapForGutter(text, gutter);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Truncate a label so the final line — base + reserved suffix — fits in
 * the terminal width. Use on spinner labels that get an elapsed counter
 * appended: if the total exceeds terminal width, clack's cursor-up
 * redraw math breaks and each tick stacks a copy of the line instead
 * of replacing it.
 *
 * `suffix` is the reserved space for what we'll append after `fit()`
 * returns (e.g. ` (999s)` or a tool-use breadcrumb). We don't include
 * it in the output — caller appends it.
 */
export function fitToWidth(base: string, suffix: string): string {
  const cols = process.stdout.columns ?? 80;
  // Overhead we reserve before sizing the label:
  //   spinner icon (1) + 2 padding spaces = 3
  //   clack's animated ellipsis after the label = up to 3 (". " -> "...")
  //   1-char safety margin so wide-char glyphs don't tip over the edge
  // Total reserved budget = 7 cols plus the caller's suffix.
  const budget = Math.max(20, cols - 7 - visibleLength(suffix));
  return base.length > budget ? base.slice(0, budget - 1) + '…' : base;
}

function wrapLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  const words = line.split(' ');
  const rows: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const word of words) {
    const wLen = visibleLength(word);
    if (curLen === 0) {
      cur = word;
      curLen = wLen;
    } else if (curLen + 1 + wLen <= width) {
      cur += ' ' + word;
      curLen += 1 + wLen;
    } else {
      rows.push(cur);
      cur = word;
      curLen = wLen;
    }
  }
  if (cur) rows.push(cur);
  return rows.join('\n');
}
