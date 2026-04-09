#!/usr/bin/env node
// score-guess.mjs — score a single Wordle guess end-to-end.
//
// Usage (CLI from agent): node score-guess.mjs <player> <guess>
//
// Reads today's word + budget from Portillo Games > Wordle Today, validates
// the guess against the wordlist, scores it, appends to Wordle State, and
// prints a JSON result the agent uses to compose its DM reply.
//
// Returned shape:
//   { ok, status, message?, grid?, guesses?, solved?, budget?, word? }
//
// status values:
//   - "scored"      → grid + guesses returned, agent posts to DM
//   - "invalid"     → guess not in wordlist, no row written
//   - "done"        → player already finished today
//   - "no_puzzle"   → Wordle Today not yet published
//   - "error"       → unexpected error (message has detail)

import fs from 'fs';
// Relative import works on host (vitest) and in container alike.
import {
  getAccessToken,
  readRange,
  appendRows,
} from '../../global/scripts/lib/sheets.mjs';
import {
  isValidGuessShape,
  scoreGuess,
} from '../../global/scripts/lib/wordle.mjs';

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const WORDLIST_PATH = '/workspace/group/wordle_wordlist.txt';

function todayCT() {
  // YYYY-MM-DD in America/Chicago
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

export async function scoreGuessForPlayer(player, rawGuess, deps = {}) {
  const {
    readRangeFn = readRange,
    appendRowsFn = appendRows,
    token: providedToken,
    today = todayCT(),
    wordlistLoader = () =>
      new Set(fs.readFileSync(WORDLIST_PATH, 'utf8').split('\n').map((s) => s.trim().toLowerCase())),
  } = deps;

  const guess = (rawGuess || '').trim().toLowerCase();

  // 1. Read today's puzzle row
  let todayRows;
  try {
    const t = providedToken ?? (await getAccessToken());
    todayRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Wordle Today!A2:C100', { token: t });
    deps._token = t; // share token for downstream calls
  } catch (err) {
    if (/Unable to parse range|404/.test(err.message)) {
      return { ok: false, status: 'no_puzzle', message: "Today's puzzle isn't set up yet." };
    }
    return { ok: false, status: 'error', message: err.message };
  }

  const row = (todayRows || []).find((r) => r[0] === today);
  if (!row) {
    return { ok: false, status: 'no_puzzle', message: "Today's puzzle isn't published yet." };
  }
  const word = (row[1] || '').toLowerCase();
  let budgets = {};
  try {
    budgets = JSON.parse(row[2] || '{}');
  } catch {
    /* ignore */
  }
  const budget = budgets[player] || 6;

  // 2. Validate shape + wordlist
  if (!isValidGuessShape(guess, word.length)) {
    return {
      ok: false,
      status: 'invalid',
      message: `Need a ${word.length}-letter word.`,
    };
  }
  const wordlist = wordlistLoader();
  if (!wordlist.has(guess)) {
    return {
      ok: false,
      status: 'invalid',
      message: `"${guess}" isn't in my dictionary.`,
    };
  }

  // 3. Read player's existing guesses today
  const stateRows = await readRangeFn(
    PORTILLO_GAMES_SHEET,
    'Wordle State!A2:F10000',
    { token: deps._token },
  );
  const mine = (stateRows || []).filter((r) => r[0] === today && r[1] === player);
  const usedCount = mine.length;
  const alreadySolved = mine.some((r) => String(r[5]).toLowerCase() === 'true');

  if (alreadySolved || usedCount >= budget) {
    return {
      ok: false,
      status: 'done',
      message: "You're done for today — wait for the reveal.",
      budget,
      guesses: usedCount,
    };
  }

  // 4. Score
  const grid = scoreGuess(guess, word);
  const solved = guess === word;
  const guessNum = usedCount + 1;

  // 5. Append row
  await appendRowsFn(
    PORTILLO_GAMES_SHEET,
    'Wordle State!A:F',
    [[today, player, guessNum, guess.toUpperCase(), grid, String(solved)]],
    { token: deps._token },
  );

  // 6. Build full history for the reply
  const history = [
    ...mine.map((r) => ({ guess: r[3], grid: r[4] })),
    { guess: guess.toUpperCase(), grid },
  ];

  return {
    ok: true,
    status: 'scored',
    grid,
    solved,
    guess_num: guessNum,
    budget,
    history,
    // Word only revealed when player exhausts budget unsolved
    word: !solved && guessNum >= budget ? word.toUpperCase() : undefined,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , player, guess] = process.argv;
  if (!player || !guess) {
    process.stderr.write('usage: score-guess.mjs <player> <guess>\n');
    process.exit(2);
  }
  scoreGuessForPlayer(player, guess)
    .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
    .catch((err) => {
      process.stdout.write(JSON.stringify({ ok: false, status: 'error', message: err.message }) + '\n');
      process.exit(1);
    });
}
