/**
 * QA scenarios — direct-call + HTTP UX tests.
 *
 * Each scenario declares:
 *   setup   - rows to insert into tracked_items
 *   trigger - call a function or POST to a mini-app endpoint
 *   expect  - structural assertions on captured outbound Telegram calls,
 *             DB state after, or HTTP response
 *
 * The scenario runner:
 *   1. Opens a fresh in-memory SQLite (schema identical to production).
 *   2. Installs the Telegram QA capture hook so outbound calls are
 *      collected into a ring buffer instead of hitting the network.
 *   3. Runs setup -> trigger -> captures outputs -> evaluates expects.
 *   4. Prints a pass/fail report.
 *
 * Usage: npm run qa:scenarios
 *
 * Exit: 0 = all pass, 1 = any fail, 2 = runner crashed.
 *
 * To add a scenario: drop a new .json file in scripts/qa/scenarios/
 * and register its trigger + expect logic below if it needs a new shape.
 */
import fs from 'node:fs';
import path from 'node:path';

type TelegramCall = {
  kind: 'sendMessage' | 'editMessage' | 'pinMessage';
  chatId: string | number;
  messageId?: number;
  text?: string;
  opts?: { parse_mode?: string; reply_markup?: unknown };
};

type ScenarioTrigger =
  | {
      type: 'pushAttentionItem';
      args: {
        chatId: string;
        itemId: string;
        title: string;
        reason: string;
        sender: string;
      };
    }
  | { type: 'handleArchive'; args: { itemId: string } }
  | { type: 'handleDismiss'; args: { itemId: string } }
  | {
      type: 'handleSnooze';
      args: { itemId: string; duration: '1h' | 'tomorrow' };
    }
  | {
      type: 'renderAttentionDashboard';
      args: { chatId: string; items: unknown[] };
    }
  | { type: 'http'; method: 'GET' | 'POST'; path: string; body?: unknown };

interface ScenarioExpect {
  // outbound-call assertions
  outbound?: {
    totalCalls?: number;
    kinds?: Array<TelegramCall['kind']>;
    keyboard?: {
      rows: number;
      buttons: number;
      callbackDataContains?: string[];
      callbackDataExcludes?: string[];
    };
  };
  // DB assertions — each is a SQL query that must return the expected count
  db?: Array<{ query: string; expectCount: number; bindings?: unknown[] }>;
  // DB assertions — SELECT single value and match
  dbValue?: Array<{
    query: string;
    bindings?: unknown[];
    column: string;
    equals: unknown;
  }>;
  // HTTP response assertions
  http?: { status: number; bodyContains?: string[]; jsonMatches?: unknown };
}

interface TrackedItemFixture {
  id?: string;
  title?: string;
  sender?: string;
  classification?: string;
  queue?: string;
  state?: string;
  model_tier?: number;
  confidence?: number;
}

interface Scenario {
  name: string;
  description: string;
  setup?: { insertTrackedItems?: TrackedItemFixture[] };
  trigger: ScenarioTrigger;
  expect: ScenarioExpect;
}

interface ScenarioResult {
  name: string;
  ok: boolean;
  failures: string[];
}

const SCENARIO_DIR = path.resolve('scripts/qa/scenarios');

async function loadScenarios(): Promise<Scenario[]> {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map(
    (f) => JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf-8')) as Scenario,
  );
}

function insertFixture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  f: TrackedItemFixture,
  index: number,
): string {
  const id = f.id ?? `qa-fixture-${index}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO tracked_items (
      id, source, source_id, group_name, state, classification, superpilot_label,
      trust_tier, title, summary, thread_id, detected_at, pushed_at,
      resolved_at, resolution_method, digest_count, telegram_message_id,
      classification_reason, metadata, confidence, model_tier, action_intent,
      facts_extracted_json, repo_candidates_json, reasons_json, reminded_at, queue
    ) VALUES (?, 'gmail', ?, 'main', ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL,
              NULL, NULL, 0, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    id,
    `gmail:${id}`,
    f.state ?? 'queued',
    f.classification ?? 'digest',
    f.title ?? 'QA fixture',
    `thread-${id}`,
    Date.now(),
    JSON.stringify({ sender: f.sender ?? 'qa@example.com' }),
    f.confidence ?? null,
    f.model_tier ?? null,
    f.queue ?? null,
  );
  return id;
}

async function runScenario(
  scn: Scenario,
): Promise<ScenarioResult> {
  const captured: TelegramCall[] = [];
  const failures: string[] = [];

  // Set up mocks/DB BEFORE importing the module under test.
  const { _initTestDatabase, _closeDatabase, getDb } = await import(
    '../../src/db.js'
  );
  const { __setTelegramQACapture } = await import(
    '../../src/channels/telegram.js'
  );

  _initTestDatabase();
  __setTelegramQACapture(async (call) => {
    captured.push(call);
    return { message_id: 1 + captured.length };
  });

  try {
    // Setup.
    const fixtureIds: string[] = [];
    if (scn.setup?.insertTrackedItems) {
      for (let i = 0; i < scn.setup.insertTrackedItems.length; i++) {
        fixtureIds.push(insertFixture(getDb(), scn.setup.insertTrackedItems[i], i));
      }
    }

    // Resolve $fixture:N references in any string arg to the real id.
    const resolveRef = (s: string): string =>
      s.startsWith('$fixture:')
        ? fixtureIds[Number(s.slice('$fixture:'.length))] ?? s
        : s;

    // Trigger.
    let httpResponse: { status: number; body: string } | null = null;
    const t = scn.trigger;
    if (t.type === 'pushAttentionItem') {
      const { pushAttentionItem } = await import(
        '../../src/triage/push-attention.js'
      );
      await pushAttentionItem({ ...t.args, itemId: resolveRef(t.args.itemId) });
    } else if (t.type === 'handleArchive') {
      const { handleArchive } = await import('../../src/triage/queue-actions.js');
      handleArchive(resolveRef(t.args.itemId));
    } else if (t.type === 'handleDismiss') {
      const { handleDismiss } = await import('../../src/triage/queue-actions.js');
      handleDismiss(resolveRef(t.args.itemId));
    } else if (t.type === 'handleSnooze') {
      const { handleSnooze } = await import('../../src/triage/queue-actions.js');
      handleSnooze(resolveRef(t.args.itemId), t.args.duration);
    } else if (t.type === 'renderAttentionDashboard') {
      const { renderAttentionDashboard } = await import(
        '../../src/triage/dashboards.js'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await renderAttentionDashboard(t.args as any);
    } else if (t.type === 'http') {
      const url = `http://localhost:3847${t.path}`;
      const res = await fetch(url, {
        method: t.method,
        headers:
          t.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: t.body !== undefined ? JSON.stringify(t.body) : undefined,
      }).catch(() => null);
      if (!res) httpResponse = { status: 0, body: '' };
      else httpResponse = { status: res.status, body: await res.text() };
    }

    // Expect: outbound calls.
    if (scn.expect.outbound) {
      const o = scn.expect.outbound;
      if (o.totalCalls !== undefined && captured.length !== o.totalCalls) {
        failures.push(
          `outbound totalCalls: expected ${o.totalCalls}, got ${captured.length}`,
        );
      }
      if (o.kinds) {
        for (const k of o.kinds) {
          if (!captured.some((c) => c.kind === k)) {
            failures.push(`outbound: missing expected kind '${k}'`);
          }
        }
      }
      if (o.keyboard) {
        const send = captured.find((c) => c.kind === 'sendMessage');
        const kb = send?.opts?.reply_markup as
          | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
          | undefined;
        const rows = kb?.inline_keyboard ?? [];
        const btns = rows.flat();
        if (rows.length !== o.keyboard.rows) {
          failures.push(
            `outbound.keyboard.rows: expected ${o.keyboard.rows}, got ${rows.length}`,
          );
        }
        if (btns.length !== o.keyboard.buttons) {
          failures.push(
            `outbound.keyboard.buttons: expected ${o.keyboard.buttons}, got ${btns.length}`,
          );
        }
        for (const frag of o.keyboard.callbackDataContains ?? []) {
          if (!btns.some((b) => (b.callback_data ?? '').includes(frag))) {
            failures.push(
              `outbound.keyboard: no button callback_data contains '${frag}'`,
            );
          }
        }
        for (const frag of o.keyboard.callbackDataExcludes ?? []) {
          if (btns.some((b) => (b.callback_data ?? '').includes(frag))) {
            failures.push(
              `outbound.keyboard: button callback_data contains forbidden '${frag}'`,
            );
          }
        }
      }
    }

    // Expect: DB counts.
    if (scn.expect.db) {
      for (const a of scn.expect.db) {
        const row = getDb()
          .prepare(a.query.replace(/\$fixture:(\d+)/g, (_m, i) => `'${fixtureIds[Number(i)]}'`))
          .get(...(a.bindings ?? [])) as { n?: number; c?: number } | undefined;
        const got = row?.n ?? row?.c ?? 0;
        if (got !== a.expectCount) {
          failures.push(
            `db count: query "${a.query.slice(0, 60)}..." expected ${a.expectCount}, got ${got}`,
          );
        }
      }
    }

    // Expect: DB single-value.
    if (scn.expect.dbValue) {
      for (const a of scn.expect.dbValue) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = getDb()
          .prepare(a.query.replace(/\$fixture:(\d+)/g, (_m, i) => `'${fixtureIds[Number(i)]}'`))
          .get(...(a.bindings ?? [])) as Record<string, any> | undefined;
        if (!row) {
          failures.push(`dbValue: query "${a.query.slice(0, 60)}..." returned no row`);
          continue;
        }
        const got = row[a.column];
        if (got !== a.equals) {
          failures.push(
            `dbValue.${a.column}: expected ${JSON.stringify(a.equals)}, got ${JSON.stringify(got)}`,
          );
        }
      }
    }

    // Expect: HTTP.
    if (scn.expect.http) {
      if (!httpResponse) {
        failures.push('http: trigger did not produce an HTTP response');
      } else {
        if (httpResponse.status !== scn.expect.http.status) {
          failures.push(
            `http.status: expected ${scn.expect.http.status}, got ${httpResponse.status}`,
          );
        }
        for (const frag of scn.expect.http.bodyContains ?? []) {
          if (!httpResponse.body.includes(frag)) {
            failures.push(`http.body: does not contain '${frag}'`);
          }
        }
        if (scn.expect.http.jsonMatches) {
          try {
            const got = JSON.parse(httpResponse.body);
            const want = scn.expect.http.jsonMatches as Record<string, unknown>;
            for (const [k, v] of Object.entries(want)) {
              if (got[k] !== v) {
                failures.push(
                  `http.jsonMatches.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`,
                );
              }
            }
          } catch {
            failures.push('http.jsonMatches: response body was not valid JSON');
          }
        }
      }
    }
  } finally {
    __setTelegramQACapture(null);
    _closeDatabase();
  }

  return { name: scn.name, ok: failures.length === 0, failures };
}

function formatReport(results: ScenarioResult[]): string {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const lines: string[] = [];
  lines.push(
    `\n=== QA scenarios: ${passed} pass, ${failed} fail (${results.length} total) ===\n`,
  );
  for (const r of results) {
    lines.push(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
    for (const f of r.failures) lines.push(`      ${f}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const scenarios = await loadScenarios();
    if (scenarios.length === 0) {
      process.stdout.write(`no scenarios in ${SCENARIO_DIR}\n`);
      process.exit(0);
    }
    const results: ScenarioResult[] = [];
    for (const s of scenarios) {
      try {
        results.push(await runScenario(s));
      } catch (err) {
        results.push({
          name: s.name,
          ok: false,
          failures: [
            `runner threw: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
      }
    }
    process.stdout.write(formatReport(results) + '\n');
    const failed = results.filter((r) => !r.ok).length;
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(
      `QA scenarios runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  }
}

main();
