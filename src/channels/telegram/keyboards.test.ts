import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL } from '../../config.js';

import {
  buildEffortKeyboard,
  buildModelKeyboard,
  buildTargetKeyboard,
  buildTaskPicker,
  buildThinkingBudgetKeyboard,
  VALID_EFFORTS,
  VALID_THINKING_BUDGETS,
} from './keyboards.js';

// Helper to flatten the inline keyboard into a {text, callback_data}[] matrix
// for structural assertions without coupling to grammy's internal layout.
function flatten(kb: {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
}): Array<{ text: string; callback_data?: string }> {
  return kb.inline_keyboard.flat();
}

describe('buildTargetKeyboard', () => {
  it('has exactly the two target buttons', () => {
    const buttons = flatten(buildTargetKeyboard());
    expect(buttons).toEqual([
      { text: 'This group', callback_data: 'cfg:tgt:grp' },
      { text: 'Task', callback_data: 'cfg:tgt:task' },
    ]);
  });
});

describe('buildModelKeyboard', () => {
  const aliases = () => ({
    opus: 'claude-opus-4-20250514',
    sonnet: 'claude-sonnet-4-20250514',
    haiku: 'claude-haiku-4-20250514',
    fast: 'claude-haiku-4-20250514',
  });

  it('marks the currently selected alias with a leading bullet', () => {
    const kb = buildModelKeyboard('claude-opus-4-20250514', 'grp', aliases);
    const labels = flatten(kb).map((b) => b.text);
    expect(labels).toContain('● opus');
    expect(labels).toContain('sonnet');
  });

  it('includes a Reset to default button with the target in callback_data', () => {
    const kb = buildModelKeyboard(undefined, 't:task-1', aliases);
    const buttons = flatten(kb);
    const reset = buttons.find((b) => b.text === 'Reset to default');
    expect(reset?.callback_data).toBe('cfg:mod:t:task-1:reset');
  });

  it('encodes alias names into callback_data verbatim', () => {
    const kb = buildModelKeyboard(undefined, 'grp', aliases);
    const sonnet = flatten(kb).find((b) => b.text === 'sonnet');
    expect(sonnet?.callback_data).toBe('cfg:mod:grp:sonnet');
  });

  it('uses default-model resolution when no currentModel is provided', () => {
    // With no override, the bullet attaches to whichever alias resolves
    // to DEFAULT_MODEL (which is env-dependent). Build an alias map that
    // deliberately contains DEFAULT_MODEL so the test is stable.
    const withDefault = () => ({
      custom: DEFAULT_MODEL,
      other: 'some-other-model',
    });
    const kb = buildModelKeyboard(undefined, 'grp', withDefault);
    const labels = flatten(kb).map((b) => b.text);
    expect(labels).toContain('● custom');
    expect(labels).toContain('other');
  });

  it('works when the alias loader returns an empty map', () => {
    const kb = buildModelKeyboard(undefined, 'grp', () => ({}));
    const buttons = flatten(kb);
    // Only the Reset-to-default row remains
    expect(buttons).toHaveLength(1);
    expect(buttons[0].text).toBe('Reset to default');
  });
});

describe('buildEffortKeyboard', () => {
  it('lists every effort level, bullets the current, and offers Reset + Back', () => {
    const kb = buildEffortKeyboard('high', 'grp');
    const labels = flatten(kb).map((b) => b.text);
    expect(labels).toContain('● high');
    for (const level of VALID_EFFORTS) {
      if (level !== 'high') expect(labels).toContain(level);
    }
    expect(labels).toContain('Reset');
    expect(labels).toContain('Back');
  });

  it('no bullet when current is undefined', () => {
    const labels = flatten(buildEffortKeyboard(undefined, 'grp')).map(
      (b) => b.text,
    );
    expect(labels.some((l) => l.startsWith('●'))).toBe(false);
  });

  it('encodes target path in callback data', () => {
    const buttons = flatten(buildEffortKeyboard('low', 't:my-task'));
    const reset = buttons.find((b) => b.text === 'Reset');
    expect(reset?.callback_data).toBe('cfg:eff:t:my-task:reset');
  });
});

describe('buildThinkingBudgetKeyboard', () => {
  it('lists every preset, bullets the current, and offers Back', () => {
    const labels = flatten(buildThinkingBudgetKeyboard('adaptive', 'grp')).map(
      (b) => b.text,
    );
    expect(labels).toContain('● adaptive');
    for (const preset of VALID_THINKING_BUDGETS) {
      if (preset !== 'adaptive') expect(labels).toContain(preset);
    }
    expect(labels).toContain('Back');
  });

  it('target is embedded in each callback data', () => {
    const buttons = flatten(buildThinkingBudgetKeyboard(undefined, 't:task-1'));
    const back = buttons.find((b) => b.text === 'Back');
    expect(back?.callback_data).toBe('cfg:tb:t:task-1:back');
    expect(
      buttons.every((b) => b.callback_data?.startsWith('cfg:tb:t:task-1:')),
    ).toBe(true);
  });
});

describe('buildTaskPicker', () => {
  it('renders one row per task with an optional [model] suffix', () => {
    const buttons = flatten(
      buildTaskPicker([
        { id: 'a', model: 'opus' },
        { id: 'b', model: null },
        { id: 'c' },
      ]),
    );
    expect(buttons.map((b) => b.text)).toEqual(['a [opus]', 'b', 'c', 'Back']);
    expect(buttons[0].callback_data).toBe('cfg:tpick:a');
  });

  it('has just a Back button when no tasks are provided', () => {
    const buttons = flatten(buildTaskPicker([]));
    expect(buttons).toEqual([{ text: 'Back', callback_data: 'cfg:tgt:back' }]);
  });
});
