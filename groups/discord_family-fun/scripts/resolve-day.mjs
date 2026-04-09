#!/usr/bin/env node
// resolve-day.mjs — resolve today's Saga Wordle.
//
// Reads Wordle Today + Wordle State + Cheat Log from Portillo Games.
// Determines winner, computes Pet Log stakes, and either writes them to
// Silverthorne (normal case) or holds them (pending cheat review).
//
// Returns JSON:
//   { status, winner, word, entries, writes, stakes_held, reason }
//
// status: "resolved" | "stakes_held" | "no_puzzle"
//
// The agent uses this to compose the day's chapter and result announcement —
// it does NOT re-derive who won or what to write. Pure logic lives in
// /workspace/global/scripts/lib/wordle.mjs.

import {
  getAccessToken,
  readRange,
  appendRows,
} from '../../global/scripts/lib/sheets.mjs';
import {
  determineWinner,
  computeDayStakes,
} from '../../global/scripts/lib/wordle.mjs';

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { player: 'Paden', pet: 'Voss' },
  { player: 'Brenda', pet: 'Nyx' },
  { player: 'Danny', pet: 'Zima' },
];

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function nowTs() {
  // YYYY-MM-DD HH:MM:SS in America/Chicago, matching date_time_convention.md
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}:${g.second}`;
}

export async function resolveDay(deps = {}) {
  const {
    readRangeFn = readRange,
    appendRowsFn = appendRows,
    today = todayCT(),
    now = nowTs(),
    token: providedToken,
  } = deps;

  const token = providedToken ?? (await getAccessToken());

  // 1. Today's puzzle
  const todayRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Wordle Today!A2:C100', { token });
  const row = (todayRows || []).find((r) => r[0] === today);
  if (!row) {
    return { ok: false, status: 'no_puzzle', message: "Today's puzzle not published." };
  }
  const word = (row[1] || '').toLowerCase();
  let budgets = {};
  try {
    budgets = JSON.parse(row[2] || '{}');
  } catch {
    /* ignore */
  }

  // 2. Wordle State (all players' guesses today)
  const stateRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Wordle State!A2:F10000', { token });
  const todays = (stateRows || []).filter((r) => r[0] === today);

  // 3. Cheat Log (pending reviews today)
  let cheatRows = [];
  try {
    cheatRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Cheat Log!A2:I10000', { token });
  } catch {
    /* optional */
  }
  const pending = (cheatRows || []).filter(
    (r) => r[1] === today && String(r[6] || '').toLowerCase() === 'pending_review',
  );

  // 4. Build per-player entries
  const entries = PLAYERS.map(({ player, pet }) => {
    const mine = todays
      .filter((r) => r[1] === player)
      .sort((a, b) => Number(a[2]) - Number(b[2]));
    const solvedRow = mine.find((r) => String(r[5]).toLowerCase() === 'true');
    const budget = budgets[player] || 6;
    const played = mine.length > 0;
    const solved = !!solvedRow;
    const guesses = mine.length;
    // Approximate solved_at from the row's implicit position — if the
    // sheet stored a timestamp col we'd read it; here we use guess number
    // as a tiebreaker proxy (fewer guesses already wins, tie → player order).
    return {
      player,
      pet,
      played,
      solved,
      guesses,
      budget,
      solved_at: solvedRow ? `${today} guess${solvedRow[2]}` : null,
    };
  });

  const winner = determineWinner(entries);
  const writes = computeDayStakes({ entries, winner, word });

  // 5. Hold stakes if any cheat is pending review
  if (pending.length > 0) {
    return {
      ok: true,
      status: 'stakes_held',
      winner,
      word,
      entries,
      writes,
      stakes_held: true,
      pending_suspects: pending.map((r) => r[2]),
      reason: 'cheat review pending',
    };
  }

  // 6. Write Pet Log rows to Silverthorne
  if (writes.length > 0) {
    const rowsToAppend = writes.map((w) => [
      now,
      today,
      w.pet,
      w.event_type,
      String(w.delta),
      w.reason,
    ]);
    await appendRowsFn(SILVERTHORNE_SHEET, 'Pet Log!A:F', rowsToAppend, { token });
  }

  return {
    ok: true,
    status: 'resolved',
    winner,
    word,
    entries,
    writes,
    stakes_held: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveDay()
    .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
    .catch((err) => {
      process.stdout.write(
        JSON.stringify({ ok: false, status: 'error', message: err.message }) + '\n',
      );
      process.exit(1);
    });
}
