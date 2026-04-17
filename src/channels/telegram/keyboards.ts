import { InlineKeyboard } from 'grammy';

import { DEFAULT_MODEL, loadModelAliases } from '../../config.js';

export const VALID_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export const VALID_THINKING_BUDGETS = [
  'low',
  'medium',
  'high',
  'adaptive',
] as const;

export type EffortLevel = (typeof VALID_EFFORTS)[number];
export type ThinkingBudgetPreset = (typeof VALID_THINKING_BUDGETS)[number];

/**
 * Two-button keyboard shown at the top of /model: "This group" vs "Task".
 */
export function buildTargetKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('This group', 'cfg:tgt:grp')
    .text('Task', 'cfg:tgt:task');
}

/**
 * Keyboard listing every known model alias for the chosen target.
 * The current effective model is marked with a leading "●". Layout is
 * 3 aliases per row, with a final "Reset to default" row.
 */
export function buildModelKeyboard(
  currentModel: string | undefined,
  target: string,
  aliasLoader: () => Record<string, string> = loadModelAliases,
): InlineKeyboard {
  const aliases = aliasLoader();
  const kb = new InlineKeyboard();
  const currentResolved = currentModel || DEFAULT_MODEL;
  let col = 0;
  for (const [alias, id] of Object.entries(aliases)) {
    if (col > 0 && col % 3 === 0) kb.row();
    const label = id === currentResolved ? `● ${alias}` : alias;
    kb.text(label, `cfg:mod:${target}:${alias}`);
    col++;
  }
  kb.row().text('Reset to default', `cfg:mod:${target}:reset`);
  return kb;
}

/**
 * Effort-level keyboard: low/medium/high/max on one row, then Reset + Back.
 */
export function buildEffortKeyboard(
  current: string | undefined,
  target: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const level of VALID_EFFORTS) {
    const label = current === level ? `● ${level}` : level;
    kb.text(label, `cfg:eff:${target}:${level}`);
  }
  kb.row()
    .text('Reset', `cfg:eff:${target}:reset`)
    .text('Back', `cfg:eff:${target}:back`);
  return kb;
}

/**
 * Thinking-budget keyboard: low/medium/high/adaptive on one row, then Back.
 */
export function buildThinkingBudgetKeyboard(
  current: string | undefined,
  target: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const preset of VALID_THINKING_BUDGETS) {
    const label = current === preset ? `● ${preset}` : preset;
    kb.text(label, `cfg:tb:${target}:${preset}`);
  }
  kb.row().text('Back', `cfg:tb:${target}:back`);
  return kb;
}

/**
 * Task picker keyboard for /model → Task → …
 */
export function buildTaskPicker(
  tasks: Array<{ id: string; model?: string | null }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of tasks) {
    const label = `${t.id}${t.model ? ` [${t.model}]` : ''}`;
    kb.text(label, `cfg:tpick:${t.id}`).row();
  }
  kb.text('Back', 'cfg:tgt:back');
  return kb;
}
