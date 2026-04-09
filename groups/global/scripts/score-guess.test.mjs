import { describe, it, expect, vi } from 'vitest';
import { scoreGuessForPlayer } from './score-guess.mjs';

const TODAY = '2026-04-07';
const todayRow = [TODAY, 'forge', JSON.stringify({ Paden: 6, Brenda: 7 })];
const wordlist = new Set(['forge', 'irate', 'crane', 'plumb']);

function makeDeps({ stateRows = [], readErr = null, append = vi.fn() } = {}) {
  let call = 0;
  const readRangeFn = vi.fn().mockImplementation(async (_id, range) => {
    call++;
    if (readErr) throw readErr;
    if (range.startsWith('Wordle Today')) return [todayRow];
    if (range.startsWith('Wordle State')) return stateRows;
    return [];
  });
  return {
    readRangeFn,
    appendRowsFn: append,
    token: 'fake',
    today: TODAY,
    wordlistLoader: () => wordlist,
  };
}

describe('scoreGuessForPlayer', () => {
  it('scores a valid first guess and appends a row', async () => {
    const append = vi.fn().mockResolvedValue({});
    const deps = makeDeps({ append });
    const r = await scoreGuessForPlayer('Paden', 'irate', deps);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('scored');
    expect(r.solved).toBe(false);
    expect(r.guess_num).toBe(1);
    expect(r.budget).toBe(6);
    expect(r.grid).toMatch(/[🟩🟨⬜]{5}/);
    expect(append).toHaveBeenCalledOnce();
    const [, , values] = append.mock.calls[0];
    expect(values[0][0]).toBe(TODAY);
    expect(values[0][1]).toBe('Paden');
    expect(values[0][2]).toBe(1);
    expect(values[0][3]).toBe('IRATE');
  });

  it('marks solved when guess matches', async () => {
    const deps = makeDeps({ append: vi.fn().mockResolvedValue({}) });
    const r = await scoreGuessForPlayer('Paden', 'forge', deps);
    expect(r.solved).toBe(true);
    expect(r.grid).toBe('🟩🟩🟩🟩🟩');
    expect(r.word).toBeUndefined(); // solved → no reveal
  });

  it('rejects words not in wordlist', async () => {
    const deps = makeDeps();
    const r = await scoreGuessForPlayer('Paden', 'qzzzx', deps);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid');
  });

  it('rejects when player has hit their budget', async () => {
    const stateRows = Array.from({ length: 6 }, (_, i) => [
      TODAY,
      'Paden',
      i + 1,
      'WRONG',
      '⬜⬜⬜⬜⬜',
      'false',
    ]);
    const deps = makeDeps({ stateRows });
    const r = await scoreGuessForPlayer('Paden', 'irate', deps);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('done');
  });

  it('reveals the word when player exhausts budget unsolved', async () => {
    const stateRows = Array.from({ length: 5 }, (_, i) => [
      TODAY,
      'Paden',
      i + 1,
      'WRONG',
      '⬜⬜⬜⬜⬜',
      'false',
    ]);
    const deps = makeDeps({ stateRows, append: vi.fn().mockResolvedValue({}) });
    const r = await scoreGuessForPlayer('Paden', 'irate', deps);
    expect(r.ok).toBe(true);
    expect(r.guess_num).toBe(6);
    expect(r.solved).toBe(false);
    expect(r.word).toBe('FORGE'); // budget exhausted → reveal
  });

  it('respects per-player budgets (Brenda gets 7)', async () => {
    const stateRows = Array.from({ length: 6 }, (_, i) => [
      TODAY,
      'Brenda',
      i + 1,
      'WRONG',
      '⬜⬜⬜⬜⬜',
      'false',
    ]);
    const deps = makeDeps({ stateRows, append: vi.fn().mockResolvedValue({}) });
    const r = await scoreGuessForPlayer('Brenda', 'irate', deps);
    // Brenda has budget 7, used 6 → still allowed
    expect(r.ok).toBe(true);
    expect(r.guess_num).toBe(7);
  });

  it('returns no_puzzle when today row is missing', async () => {
    const readRangeFn = vi.fn().mockResolvedValue([]);
    const r = await scoreGuessForPlayer('Paden', 'irate', {
      readRangeFn,
      appendRowsFn: vi.fn(),
      token: 'fake',
      today: TODAY,
      wordlistLoader: () => wordlist,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('no_puzzle');
  });

  it('returns no_puzzle on Sheets 404', async () => {
    const readRangeFn = vi.fn().mockRejectedValue(new Error('Unable to parse range Wordle Today'));
    const r = await scoreGuessForPlayer('Paden', 'irate', {
      readRangeFn,
      appendRowsFn: vi.fn(),
      token: 'fake',
      today: TODAY,
      wordlistLoader: () => wordlist,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('no_puzzle');
  });
});
