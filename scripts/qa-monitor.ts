/**
 * QA monitor — cron-driven invariant runner with transition alerting.
 *
 * Runs the full invariants suite, diffs each invariant's verdict against
 * the last persisted run, and sends a Telegram message on:
 *   - pass -> fail transition  (⚠️ regression)
 *   - fail -> pass transition  (✅ recovery)
 * Steady state (all-pass or same set of fails) is silent.
 *
 * Usage:
 *   npm run qa:monitor
 *
 * Meant to be invoked by launchd / cron every ~10 minutes. On first run
 * (no state file) we persist results without alerting.
 *
 * Gating:
 *   QA_MONITOR_DISABLED=1  - skip entire run (for planned maintenance)
 *   QA_MONITOR_DRY_RUN=1   - run + log, but don't send Telegram or
 *                            persist state (for debugging)
 *
 * Exit code:
 *   0 - run completed (regardless of pass/fail or transitions)
 *   2 - runner crashed before it could check
 */
import fs from 'node:fs';
import path from 'node:path';
import { runAll, type Result } from './qa/invariants.js';
import { readEnvValue } from '../src/env.js';

const STATE_FILE = path.resolve('data/qa-state.json');

interface PersistedState {
  runAt: number;
  byInvariant: Record<string, 'pass' | 'fail'>;
}

function loadState(): PersistedState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedState;
  } catch {
    return null;
  }
}

function saveState(state: PersistedState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function verdict(r: Result): 'pass' | 'fail' {
  return r.ok ? 'pass' : 'fail';
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  // Direct Bot API call — we're a standalone process and don't want to
  // spin up the full nanoclaw channel registry. The bot token lives in
  // .env alongside TELEGRAM_BOT_TOKEN for the main service.
  const token = readEnvValue('TELEGRAM_BOT_TOKEN');
  if (!token) {
    process.stderr.write(
      'qa-monitor: TELEGRAM_BOT_TOKEN not set; would have sent: ' +
        text +
        '\n',
    );
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  }).catch((err) => {
    process.stderr.write(`qa-monitor: Telegram send failed: ${err}\n`);
    return null;
  });
  if (res && !res.ok) {
    const body = await res.text().catch(() => '');
    process.stderr.write(
      `qa-monitor: Telegram ${res.status}: ${body.slice(0, 200)}\n`,
    );
  }
}

function formatTransitionMessage(
  regressed: Result[],
  recovered: Result[],
): string | null {
  if (regressed.length === 0 && recovered.length === 0) return null;
  const parts: string[] = [];
  if (regressed.length > 0) {
    parts.push(`⚠️ *QA regression* (${regressed.length})`);
    for (const r of regressed) {
      parts.push(`• \`${r.name}\` — ${r.message}`);
    }
  }
  if (recovered.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`✅ *QA recovery* (${recovered.length})`);
    for (const r of recovered) {
      parts.push(`• \`${r.name}\` — ${r.message}`);
    }
  }
  return parts.join('\n');
}

async function main(): Promise<void> {
  if (readEnvValue('QA_MONITOR_DISABLED') === '1') {
    process.stdout.write('qa-monitor: disabled via QA_MONITOR_DISABLED=1\n');
    process.exit(0);
  }
  const dryRun = readEnvValue('QA_MONITOR_DRY_RUN') === '1';

  let results: Result[];
  try {
    results = await runAll();
  } catch (err) {
    process.stderr.write(
      `qa-monitor: runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    // Notify on crash — this IS a regression worth knowing about.
    const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
    if (chatId && !dryRun) {
      await sendTelegram(
        chatId,
        `💥 *QA monitor crashed*\n\`${err instanceof Error ? err.message : String(err)}\``,
      );
    }
    process.exit(2);
  }

  const prev = loadState();
  const current: PersistedState = {
    runAt: Date.now(),
    byInvariant: Object.fromEntries(results.map((r) => [r.name, verdict(r)])),
  };

  // First run — establish baseline, no alerts.
  if (!prev) {
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    process.stdout.write(
      `qa-monitor: first run — baseline ${pass} pass / ${fail} fail, no alerts\n`,
    );
    if (!dryRun) saveState(current);
    process.exit(0);
  }

  // Diff verdicts against previous run.
  const regressed: Result[] = [];
  const recovered: Result[] = [];
  for (const r of results) {
    const was = prev.byInvariant[r.name];
    const now = verdict(r);
    if (was === 'pass' && now === 'fail') regressed.push(r);
    if (was === 'fail' && now === 'pass') recovered.push(r);
  }

  const message = formatTransitionMessage(regressed, recovered);
  const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
  if (message && chatId && !dryRun) {
    await sendTelegram(chatId, message);
  }

  // Auto-dispatch propose-fix on regressions (not recoveries). Fire-and-
  // forget: the propose-fix script posts its own Telegram card when done.
  // Disabled via QA_AUTO_PROPOSE_FIX=0.
  if (
    regressed.length > 0 &&
    !dryRun &&
    readEnvValue('QA_AUTO_PROPOSE_FIX') !== '0'
  ) {
    const report = {
      source: 'invariants' as const,
      failures: regressed.map((r) => ({
        name: r.name,
        message: r.message,
        category: r.category,
        details: r.details,
      })),
    };
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(
        '/opt/homebrew/bin/npm',
        ['--prefix', process.cwd(), 'run', 'qa:propose-fix'],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
      );
      child.stdin.write(JSON.stringify(report));
      child.stdin.end();
      child.unref();
      process.stdout.write(
        `qa-monitor: dispatched propose-fix for ${regressed.length} regression(s)\n`,
      );
    } catch (err) {
      process.stderr.write(
        `qa-monitor: propose-fix dispatch failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  // Always log to stdout so launchd logs capture the run.
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(
    `qa-monitor: ${pass} pass, ${fail} fail, ${regressed.length} regressions, ${recovered.length} recoveries\n`,
  );
  if (message) {
    process.stdout.write(message + '\n');
  }

  if (!dryRun) saveState(current);
  process.exit(0);
}

main();
