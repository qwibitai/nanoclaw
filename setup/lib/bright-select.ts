/**
 * A drop-in alternative to `@clack/prompts`' `p.select` that renders
 * unselected option labels at full brightness instead of dim gray.
 *
 * Why this exists: clack styles inactive options with `styleText("dim", …)`
 * inline in its render function. There is no configuration hook to override
 * it, and the feedback was clear — non-selected options in the setup flow
 * were "too light, need stronger font weight". So we write our own render
 * against `@clack/core`'s `SelectPrompt`, keeping the visual shell of clack
 * (diamond header, `│` gutter, cyan in-progress / green on submit) but
 * leaving the label un-dimmed. Only the bullet and hint stay dim, which
 * gives enough contrast for the cursor to read as "active".
 *
 * Not a full clack-feature clone: no search, no maxItems paging, no custom
 * bar characters. Just the bits the NanoClaw setup menus actually use.
 */
import { SelectPrompt } from '@clack/core';
import { isCancel } from '@clack/prompts';
import { styleText } from 'node:util';

const BULLET_ACTIVE = '●';
const BULLET_INACTIVE = '○';
const BAR = '│';
const CAP_BOT = '└';
const DIAMOND = '◆';
const DIAMOND_CANCEL = '■';
const DIAMOND_SUBMIT = '◇';

type PromptState = 'initial' | 'active' | 'error' | 'cancel' | 'submit';

function stateColor(state: PromptState): 'cyan' | 'green' | 'red' | 'yellow' {
  switch (state) {
    case 'submit':
      return 'green';
    case 'cancel':
      return 'red';
    case 'error':
      return 'yellow';
    default:
      return 'cyan';
  }
}

function headerIcon(state: PromptState): string {
  switch (state) {
    case 'submit':
      return styleText('green', DIAMOND_SUBMIT);
    case 'cancel':
      return styleText('red', DIAMOND_CANCEL);
    default:
      return styleText('cyan', DIAMOND);
  }
}

export interface BrightSelectOption<T> {
  value: T;
  label?: string;
  hint?: string;
}

export interface BrightSelectOptions<T> {
  message: string;
  options: BrightSelectOption<T>[];
  initialValue?: T;
}

/**
 * Matches the return shape of `p.select` — resolves to the selected value
 * on submit, or to clack's cancel symbol on Ctrl-C / Esc. Callers pass
 * the result through `ensureAnswer(...)` the same way they do for
 * `p.select`.
 */
export function brightSelect<T>(
  opts: BrightSelectOptions<T>,
): Promise<T | symbol> {
  const { message, options, initialValue } = opts;

  return new SelectPrompt({
    options: options as Array<{ value: T; label?: string; hint?: string }>,
    initialValue,
    render() {
      const st = this.state as PromptState;
      const color = stateColor(st);
      const bar = styleText(color, BAR);
      const grayBar = styleText('gray', BAR);

      const lines: string[] = [];
      lines.push(grayBar);
      lines.push(`${headerIcon(st)}  ${message}`);

      if (st === 'submit' || st === 'cancel') {
        const selected =
          options.find((o) => o.value === this.value)?.label ??
          String(this.value ?? '');
        const shown =
          st === 'cancel'
            ? styleText(['strikethrough', 'dim'], selected)
            : styleText('dim', selected);
        lines.push(`${grayBar}  ${shown}`);
        return lines.join('\n');
      }

      const cursor = (this as unknown as { cursor: number }).cursor;
      options.forEach((opt, idx) => {
        const label = opt.label ?? String(opt.value);
        const hint = opt.hint ? ` ${styleText('dim', `(${opt.hint})`)}` : '';
        const marker =
          idx === cursor
            ? styleText('green', BULLET_ACTIVE)
            : styleText('dim', BULLET_INACTIVE);
        lines.push(`${bar}  ${marker} ${label}${hint}`);
      });
      lines.push(styleText(color, CAP_BOT));
      return lines.join('\n');
    },
  }).prompt() as Promise<T | symbol>;
}

export { isCancel };
