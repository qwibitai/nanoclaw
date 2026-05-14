#!/usr/bin/env pnpm exec tsx
/**
 * X export-bookmarks — bulk-dump all bookmarks to CSV.
 *
 * Why a separate tool from read-bookmarks:
 *   - Read returns rows in the chat reply, capped at 100/call. For users
 *     with thousands of bookmarks, the cursor-in-chat pattern multiplies
 *     round-trips and burns context.
 *   - Export writes a CSV file directly; the agent gets only a summary.
 *
 * Why resumable instead of one giant call:
 *   - The host's per-script timeout is 120s. Single-call full export
 *     would time out on any non-trivial history.
 *   - State sidecar `<csv>.progress.json` records `{lastId, totalRows}`
 *     so each invocation skips past prior rows and appends fresh ones.
 *   - Each call has a soft time budget (~75s) so it finishes before the
 *     host's hard timeout, leaving headroom for parse + I/O.
 *
 * Output location:
 *   groups/main/captures/bookmarks.csv  (host path)
 *   /workspace/group/captures/bookmarks.csv  (agent's view via container mount)
 *
 * For now, group=main is hardcoded — only the main group uses X
 * integration in this install. If/when other groups want their own
 * export, thread the agent group folder in via host buildArgs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { parseTweetCard, type ParsedTweet } from '../lib/extract.js';
import { X_URLS, X_SELECTORS } from '../lib/locators.js';

interface Input { reset?: boolean }

interface Progress {
  /** Tweet ID of the most recently exported bookmark (the one the next
   *  call should fast-forward past). */
  lastId: string | null;
  /** Total rows in the CSV (excluding header). */
  totalRows: number;
  /** ISO timestamp of last successful flush. */
  lastUpdated: string;
}

const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const CSV_PATH = path.join(PROJECT_ROOT, 'groups', 'main', 'captures', 'bookmarks.csv');
const PROGRESS_PATH = `${CSV_PATH}.progress.json`;
const CSV_HEADER = 'id,url,author_handle,author_name,timestamp,text,image_alt_texts,likes,retweets,replies,is_reply,is_retweet';

/** Soft time budget per invocation. The host kills the script at 120s
 *  hard timeout; we exit voluntarily at 75s with everything flushed. */
const TIME_BUDGET_MS = 75_000;

/** Pause between scroll-trigger and re-parse. Same as collectTweets. */
const SCROLL_PAUSE_MS = 800;

// ── CSV serialization (RFC 4180) ─────────────────────────────

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function tweetToCsvRow(t: ParsedTweet): string {
  const cells = [
    t.id,
    t.url,
    t.authorHandle,
    t.authorName,
    t.timestamp,
    t.text,
    t.imageAltTexts.join(' | '),
    String(t.metrics.likes),
    String(t.metrics.retweets),
    String(t.metrics.replies),
    t.isReply ? '1' : '0',
    t.isRetweet ? '1' : '0',
  ];
  return cells.map((c) => csvEscape(c ?? '')).join(',');
}

// ── Progress sidecar ─────────────────────────────────────────

function readProgress(): Progress {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf8');
    const p = JSON.parse(raw);
    return {
      lastId: typeof p.lastId === 'string' ? p.lastId : null,
      totalRows: Number.isInteger(p.totalRows) ? p.totalRows : 0,
      lastUpdated: typeof p.lastUpdated === 'string' ? p.lastUpdated : new Date().toISOString(),
    };
  } catch {
    return { lastId: null, totalRows: 0, lastUpdated: new Date().toISOString() };
  }
}

function writeProgress(p: Progress): void {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

// ── Main ─────────────────────────────────────────────────────

async function exportBookmarks(input: Input): Promise<ScriptResult> {
  const reset = input.reset === true;

  // Ensure target directory exists
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });

  // Reset clears CSV + sidecar; otherwise resume from progress.json
  if (reset) {
    if (fs.existsSync(CSV_PATH)) fs.unlinkSync(CSV_PATH);
    if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  }

  const isFreshFile = !fs.existsSync(CSV_PATH);
  if (isFreshFile) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n');
  }

  const progress = readProgress();
  const skipUntilId = progress.lastId ?? undefined;

  const startedAt = Date.now();
  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  let pageError: string | null = null;
  let newRows = 0;
  let lastNewId: string | null = progress.lastId;
  let oldestNewTimestamp: string | null = null;

  try {
    await page.goto(X_URLS.bookmarks, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) {
      await context.close();
      return auth;
    }

    // Custom scroll-and-collect loop (NOT collectTweets) so we can:
    //   - Track elapsed time precisely against TIME_BUDGET_MS
    //   - Flush rows to disk incrementally so a mid-run crash still
    //     preserves what we already collected
    //   - Detect "scroll stalled" (height not increasing → end of feed)
    const seen = new Set<string>();
    let pastMarker = !skipUntilId;
    let prevScrollHeight = 0;
    let stalledRounds = 0;

    // Open CSV in append mode for this session
    const csvFd = fs.openSync(CSV_PATH, 'a');

    try {
      while (Date.now() - startedAt < TIME_BUDGET_MS) {
        const articles = page.locator(X_SELECTORS.tweet);
        const count = await articles.count();
        let collectedThisRound = 0;

        for (let i = 0; i < count; i++) {
          if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
          const parsed = await parseTweetCard(articles.nth(i));
          if (!parsed.id || seen.has(parsed.id)) continue;
          seen.add(parsed.id);
          if (!pastMarker) {
            if (parsed.id === skipUntilId) pastMarker = true;
            continue;
          }
          // New tweet — flush a CSV row and bump counters
          fs.writeSync(csvFd, tweetToCsvRow(parsed) + '\n');
          newRows += 1;
          collectedThisRound += 1;
          lastNewId = parsed.id;
          if (parsed.timestamp) oldestNewTimestamp = parsed.timestamp;
        }

        // End-of-feed detection: scroll height didn't grow for several
        // consecutive rounds AND no new tweets parsed → we're done.
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        if (scrollHeight === prevScrollHeight && collectedThisRound === 0) {
          stalledRounds += 1;
          if (stalledRounds >= 3) break;
        } else {
          stalledRounds = 0;
          prevScrollHeight = scrollHeight;
        }

        if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(SCROLL_PAUSE_MS);
      }
    } finally {
      fs.closeSync(csvFd);
    }

    // Update progress sidecar regardless of how the loop exited (timed
    // out vs feed-end vs error). Lets the next call resume cleanly.
    if (newRows > 0 && lastNewId) {
      writeProgress({
        lastId: lastNewId,
        totalRows: progress.totalRows + newRows,
        lastUpdated: new Date().toISOString(),
      });
    } else if (isFreshFile || reset) {
      // First call with no rows — still write a sidecar so subsequent
      // calls don't think it's a fresh start.
      writeProgress({
        lastId: progress.lastId,
        totalRows: progress.totalRows,
        lastUpdated: new Date().toISOString(),
      });
    }

    const totalRows = progress.totalRows + newRows;
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    // Decide whether more work is likely available.
    // Heuristic: if we collected >0 rows in this call, there's probably
    // more (we cut off at the time budget). If we collected 0 AND the
    // marker was found (or was already null on a fresh export), the
    // feed is exhausted.
    const moreAvailable = newRows > 0;

    const summary = [
      `Bookmark export — appended ${newRows} row${newRows === 1 ? '' : 's'} in ${elapsedSec}s.`,
      `CSV: ${CSV_PATH}`,
      `(Agent path: /workspace/group/captures/bookmarks.csv)`,
      `Total rows: ${totalRows}.`,
      oldestNewTimestamp ? `Oldest new bookmark: ${oldestNewTimestamp}.` : null,
      moreAvailable
        ? `More likely available — call x_export_bookmarks again to continue.`
        : `End of bookmarks reached.`,
    ].filter(Boolean).join(' ');

    return {
      success: true,
      message: summary,
      data: {
        csvPath: CSV_PATH,
        agentPath: '/workspace/group/captures/bookmarks.csv',
        appendedRows: newRows,
        totalRows,
        moreAvailable,
        oldestNewTimestamp,
      },
    };
  } catch (err) {
    pageError = err instanceof Error ? err.message : String(err);
    await captureFailure(page, 'export-bookmarks-error');
    // Still update progress so partial exports are resumable
    if (newRows > 0 && lastNewId) {
      writeProgress({
        lastId: lastNewId,
        totalRows: progress.totalRows + newRows,
        lastUpdated: new Date().toISOString(),
      });
    }
    return {
      success: false,
      message: `export-bookmarks error after ${newRows} row(s): ${pageError}. Progress saved — re-run x_export_bookmarks to resume.`,
    };
  } finally {
    await context.close();
  }
}

runScript<Input>(exportBookmarks);
