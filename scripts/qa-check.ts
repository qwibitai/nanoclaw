/**
 * QA autopilot — invariants runner.
 *
 * Checks a seed set of invariants against the live nanoclaw state (DB,
 * logs, HTTP endpoints) and prints a report. The focus is on catching
 * silent bugs that chat-based tests can't see — env-bridge failures,
 * data-quality regressions, state-machine orphans.
 *
 * Usage:
 *   npm run qa:check
 *   npm run qa:check -- --fail-fast
 *
 * Exit code:
 *   0 = all invariants pass
 *   1 = one or more invariants fail
 *   2 = runner crashed before it could check
 *
 * Extending: add an entry to `invariants` below. Each invariant returns
 * { ok: boolean, message: string, details?: unknown }. Keep them cheap
 * (< 1s) so the whole sweep finishes in a few seconds.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

interface Result {
  name: string;
  category: 'db' | 'log' | 'http' | 'env';
  ok: boolean;
  message: string;
  details?: unknown;
}

const STORE = path.resolve('store/messages.db');
const LOG = path.resolve('logs/nanoclaw.log');
const TRIAGE_LOG_DIR = path.resolve('.omc/logs/triage');
const MINI_APP_URL = 'http://localhost:3847';

function openDb(): Database.Database {
  if (!fs.existsSync(STORE)) {
    throw new Error(`store not found at ${STORE}`);
  }
  return new Database(STORE, { readonly: true });
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url).catch(() => null);
  if (!res) return { status: 0, body: '' };
  return { status: res.status, body: await res.text() };
}

async function httpPost(
  url: string,
  json: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  }).catch(() => null);
  if (!res) return { status: 0, body: '' };
  return { status: res.status, body: await res.text() };
}

// ────────────────────────────────────────────────────────────────────────
// Invariants. Each returns a Result. Add new ones by appending to the array.
// ────────────────────────────────────────────────────────────────────────

async function run(): Promise<Result[]> {
  const db = openDb();
  const results: Result[] = [];
  const now = Date.now();

  // DB — state-machine orphans
  {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM tracked_items WHERE state='queued' AND queue='ignore'`,
        )
        .get() as { n: number }
    ).n;
    results.push({
      name: 'no-orphan-ignore-items',
      category: 'db',
      ok: n === 0,
      message:
        n === 0
          ? 'no queued items with queue=ignore'
          : `${n} ignore-classified items stuck in queued state`,
      details: { count: n },
    });
  }

  {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM tracked_items
           WHERE state='queued' AND queue='attention'
             AND detected_at < ?`,
        )
        .get(now - 5 * 60_000) as { n: number }
    ).n;
    results.push({
      name: 'attention-items-pushed-within-5m',
      category: 'db',
      ok: n === 0,
      message:
        n === 0
          ? 'all attention items were pushed within 5m of detection'
          : `${n} attention items stuck in queued state > 5m (push failed?)`,
      details: { count: n },
    });
  }

  // DB — data quality: archive queue shouldn't be dominated by unknown senders
  {
    const rows = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN json_extract(metadata,'$.sender') IN ('','unknown') OR json_extract(metadata,'$.sender') IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM tracked_items
         WHERE state='queued' AND queue='archive_candidate'`,
      )
      .get() as { total: number; unknown: number };
    const ratio = rows.total === 0 ? 0 : rows.unknown / rows.total;
    results.push({
      name: 'archive-queue-unknown-sender-ratio',
      category: 'db',
      ok: ratio < 0.5,
      message:
        rows.total === 0
          ? 'archive queue empty'
          : `${((1 - ratio) * 100).toFixed(0)}% of archive queue has known senders (${rows.total - rows.unknown}/${rows.total})`,
      details: rows,
    });
  }

  // DB — no stale duplicate titles (same title+sender within 10 min)
  {
    const dups = db
      .prepare(
        `SELECT title, json_extract(metadata,'$.sender') AS sender, COUNT(*) AS n
         FROM tracked_items
         WHERE state IN ('queued','pushed')
           AND detected_at > ?
           AND title != ''
         GROUP BY title, sender
         HAVING n > 1`,
      )
      .all(now - 10 * 60_000) as Array<{
      title: string;
      sender: string;
      n: number;
    }>;
    results.push({
      name: 'no-duplicate-active-items-10m',
      category: 'db',
      ok: dups.length === 0,
      message:
        dups.length === 0
          ? 'no duplicate title+sender pairs in last 10m'
          : `${dups.length} duplicate pair(s) in last 10m`,
      details: dups.slice(0, 5),
    });
  }

  // DB — classifier liveness
  {
    const row = db
      .prepare(
        `SELECT MAX(detected_at) AS last FROM tracked_items WHERE model_tier IS NOT NULL`,
      )
      .get() as { last: number | null };
    const ageHours = row.last ? (now - row.last) / 3_600_000 : Infinity;
    results.push({
      name: 'classifier-fired-recently',
      category: 'db',
      ok: ageHours < 6,
      message:
        row.last === null
          ? 'classifier has NEVER fired'
          : `last classification ${ageHours.toFixed(1)}h ago`,
      details: { lastDetectedAtMs: row.last },
    });
  }

  // DB — every v1-classified row has a queue value (post-migration invariant)
  {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM tracked_items WHERE model_tier IS NOT NULL AND queue IS NULL`,
        )
        .get() as { n: number }
    ).n;
    results.push({
      name: 'all-classified-rows-have-queue',
      category: 'db',
      ok: n === 0,
      message:
        n === 0
          ? 'every classified row has a queue value'
          : `${n} classified rows missing queue column`,
      details: { count: n },
    });
  }

  // DB — skip-list looks sane (not empty forever once live)
  {
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM triage_skip_list`).get() as {
        n: number;
      }
    ).n;
    // Warn only — a fresh install legitimately has an empty skip list.
    results.push({
      name: 'skip-list-size',
      category: 'db',
      ok: true,
      message: `skip list has ${n} entries (warn-only)`,
      details: { count: n },
    });
  }

  // Log — SSE field-presence ratio in today's traffic
  {
    if (!fs.existsSync(LOG)) {
      results.push({
        name: 'sse-field-presence-ratio',
        category: 'log',
        ok: false,
        message: `log not found at ${LOG}`,
      });
    } else {
      const tail = tailLines(LOG, 5000);
      const events = tail
        .split('\n')
        .filter((l) => l.includes('SSE triaged_emails field-presence'));
      let total = 0;
      let withSubject = 0;
      for (const line of events) {
        // pino dev format splits fields across lines; gather next few lines
        const idx = tail.indexOf(line);
        const block = tail.slice(idx, idx + 500);
        const mT = /total.*?(\d+)/.exec(block);
        const mS = /withSubject.*?(\d+)/.exec(block);
        if (mT) total += Number(mT[1]);
        if (mS) withSubject += Number(mS[1]);
      }
      const ratio = total === 0 ? 1 : withSubject / total;
      results.push({
        name: 'sse-field-presence-ratio',
        category: 'log',
        ok: total === 0 || ratio >= 0.9,
        message:
          total === 0
            ? 'no SSE field-presence events in recent log (no SSE traffic yet)'
            : `withSubject/total = ${(ratio * 100).toFixed(0)}% (${withSubject}/${total}) in last ${events.length} events`,
        details: { total, withSubject, events: events.length },
      });
    }
  }

  // Log — triage trace error ratio in recent traffic only. Full-day
  // tally would permanently reflect pre-fix outages; narrowing to the
  // last hour keeps the signal current.
  {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(TRIAGE_LOG_DIR, `${today}.jsonl`);
    const windowMs = 60 * 60_000;
    const cutoff = now - windowMs;
    let total = 0;
    let errors = 0;
    if (fs.existsSync(file)) {
      const lines = fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l) as { timestamp?: number; queue?: string };
          if (!t.timestamp || t.timestamp < cutoff) continue;
          total++;
          if (t.queue === 'error') errors++;
        } catch {
          /* skip malformed */
        }
      }
    }
    const errRatio = total === 0 ? 0 : errors / total;
    results.push({
      name: 'triage-trace-error-ratio-1h',
      category: 'log',
      ok: errRatio < 0.1,
      message:
        total === 0
          ? 'no triage traces in the last hour'
          : `${errors}/${total} (${(errRatio * 100).toFixed(0)}%) traces errored in last hour`,
      details: { total, errors, windowMs },
    });
  }

  // HTTP — mini-app root returns 200 with expected content
  {
    const r = await httpGet(MINI_APP_URL + '/');
    const ok =
      r.status === 200 &&
      r.body.includes('Archive queue') &&
      r.body.includes('Attention');
    results.push({
      name: 'miniapp-root-renders',
      category: 'http',
      ok,
      message:
        r.status === 0
          ? 'mini-app server not reachable'
          : `GET / -> ${r.status}, body-has-markers=${r.body.includes('Archive queue')}`,
      details: { status: r.status, len: r.body.length },
    });
  }

  // HTTP — bulk archive endpoint validates inputs
  {
    const r = await httpPost(MINI_APP_URL + '/api/archive/bulk', {
      itemIds: [],
    });
    results.push({
      name: 'miniapp-bulk-archive-rejects-empty',
      category: 'http',
      ok: r.status === 400,
      message: `POST /api/archive/bulk with empty array -> ${r.status}`,
      details: { status: r.status },
    });
  }

  // ENV — required env values are reachable at runtime
  {
    const envFile = path.resolve('.env');
    const required = [
      'TRIAGE_V1_ENABLED',
      'TRIAGE_SHADOW_MODE',
      'EMAIL_INTEL_TG_CHAT_ID',
      'ANTHROPIC_API_KEY',
      'NANOCLAW_SERVICE_TOKEN',
      'MINI_APP_URL',
    ];
    const content = fs.existsSync(envFile)
      ? fs.readFileSync(envFile, 'utf-8')
      : '';
    const missing = required.filter((k) => {
      const line = content
        .split('\n')
        .find((l) => l.startsWith(k + '=') && !l.startsWith('#'));
      if (!line) return true;
      const val = line.slice(k.length + 1).trim();
      return !val;
    });
    results.push({
      name: 'required-env-keys-populated',
      category: 'env',
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? `all ${required.length} required env keys are set in .env`
          : `missing from .env: ${missing.join(', ')}`,
      details: { missing },
    });
  }

  // ENV — triage shadow mode is OFF (i.e., live)
  {
    const line = fs
      .readFileSync(path.resolve('.env'), 'utf-8')
      .split('\n')
      .find((l) => l.startsWith('TRIAGE_SHADOW_MODE='));
    const val = line ? line.split('=')[1].trim() : '';
    results.push({
      name: 'triage-not-in-shadow-mode',
      category: 'env',
      ok: val === '0' || val.toLowerCase() === 'false',
      message: `TRIAGE_SHADOW_MODE=${val || '(unset)'}`,
      details: { val },
    });
  }

  db.close();
  return results;
}

function tailLines(file: string, maxLines: number): string {
  // Cheap tail: read last ~1MB. Good enough for recent-event scanning.
  const size = fs.statSync(file).size;
  const readFrom = Math.max(0, size - 1_000_000);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - readFrom);
  fs.readSync(fd, buf, 0, buf.length, readFrom);
  fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\n');
  return lines.slice(-maxLines).join('\n');
}

function formatReport(results: Result[]): string {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const lines: string[] = [];
  lines.push(
    `\n=== QA invariants: ${passed} pass, ${failed} fail (${results.length} total) ===\n`,
  );
  const byCat = new Map<string, Result[]>();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }
  for (const [cat, rs] of byCat) {
    lines.push(`[${cat}]`);
    for (const r of rs) {
      lines.push(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.message}`);
    }
    lines.push('');
  }
  if (failed > 0) {
    lines.push('--- Failed details ---');
    for (const r of results.filter((x) => !x.ok)) {
      lines.push(
        `  ${r.name}: ${JSON.stringify(r.details ?? {}, null, 2).slice(0, 400)}`,
      );
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const results = await run();
    process.stdout.write(formatReport(results) + '\n');
    const failed = results.filter((r) => !r.ok).length;
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(
      `QA runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  }
}

main();
