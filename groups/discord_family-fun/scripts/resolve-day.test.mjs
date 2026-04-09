import { describe, it, expect, vi } from 'vitest';
import { resolveDay } from './resolve-day.mjs';

const TODAY = '2026-04-07';

function makeDeps({ todayRows, stateRows, cheatRows = [] }) {
  const appendRowsFn = vi.fn().mockResolvedValue({});
  const readRangeFn = vi.fn().mockImplementation(async (_sheet, range) => {
    if (range.startsWith('Wordle Today')) return todayRows;
    if (range.startsWith('Wordle State')) return stateRows;
    if (range.startsWith('Cheat Log')) return cheatRows;
    return [];
  });
  return {
    readRangeFn,
    appendRowsFn,
    token: 'fake',
    today: TODAY,
    now: '2026-04-07 18:00:00',
  };
}

describe('resolveDay', () => {
  it('picks winner, writes XP + decay rows', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [
      [TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
      [TODAY, 'Brenda', '1', 'SLATE', '⬜⬜🟨⬜🟨', 'false'],
      [TODAY, 'Brenda', '2', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
      // Danny never played
    ];
    const deps = makeDeps({ todayRows, stateRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('resolved');
    expect(result.winner).toBe('Paden');
    expect(result.writes).toEqual([
      {
        player: 'Paden',
        pet: 'Voss',
        event_type: 'xp_gain',
        delta: 20,
        reason: 'Saga Wordle win — crane',
      },
      {
        player: 'Danny',
        pet: 'Zima',
        event_type: 'decay',
        delta: -10,
        reason: 'Saga Wordle — did not play',
      },
    ]);
    expect(deps.appendRowsFn).toHaveBeenCalledTimes(1);
    const appended = deps.appendRowsFn.mock.calls[0][2];
    expect(appended).toHaveLength(2);
    expect(appended[0]).toEqual([
      '2026-04-07 18:00:00',
      TODAY,
      'Voss',
      'xp_gain',
      '20',
      'Saga Wordle win — crane',
    ]);
  });

  it('holds stakes when a cheat review is pending', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const cheatRows = [
      ['2026-04-07 09:00:00', TODAY, 'Paden', 'one_guess_solve', 'crane', '1', 'pending_review', '', 'FALSE'],
    ];
    const deps = makeDeps({ todayRows, stateRows, cheatRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('stakes_held');
    expect(result.stakes_held).toBe(true);
    expect(result.pending_suspects).toEqual(['Paden']);
    expect(deps.appendRowsFn).not.toHaveBeenCalled();
  });

  it('returns no_puzzle when no row for today', async () => {
    const deps = makeDeps({ todayRows: [], stateRows: [] });
    const result = await resolveDay(deps);
    expect(result.status).toBe('no_puzzle');
  });

  it('no winner when nobody solved — all non-solvers lose -10', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [
      [TODAY, 'Paden', '1', 'SLATE', '⬜⬜🟨⬜🟨', 'false'],
      [TODAY, 'Paden', '2', 'BRICK', '⬜🟨⬜⬜⬜', 'false'],
      [TODAY, 'Paden', '3', 'DRIFT', '⬜🟨⬜⬜⬜', 'false'],
      [TODAY, 'Paden', '4', 'FLINT', '⬜⬜⬜⬜⬜', 'false'],
      [TODAY, 'Paden', '5', 'GUSTO', '⬜⬜⬜⬜⬜', 'false'],
      [TODAY, 'Paden', '6', 'JOKER', '⬜⬜⬜⬜⬜', 'false'],
    ];
    const deps = makeDeps({ todayRows, stateRows });
    const result = await resolveDay(deps);

    expect(result.winner).toBeNull();
    expect(result.writes).toHaveLength(3);
    expect(result.writes.every((w) => w.event_type === 'decay')).toBe(true);
  });
});
