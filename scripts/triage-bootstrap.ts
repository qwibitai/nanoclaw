/**
 * Bootstrap triage skip-list and examples from historical email data.
 *
 * Fetches archived emails from SuperPilot, classifies each with the triage
 * classifier, and seeds `triage_skip_list` + `triage_examples` based on
 * classifier/user agreement.
 *
 * Data source: SuperPilot's `GET /api/nanoclaw/triaged-emails` endpoint.
 * TODO(v2): Gmail MCP fallback when SuperPilot is unavailable.
 *
 * Classification: the plan mentions the Anthropic Batch API for cost
 * efficiency, but for a one-off overnight seeding run we use serial calls
 * through the existing `classifyWithLlm` (same code path as production)
 * with a small inter-call delay. This keeps the script simple, reuses the
 * tested tier-escalation + prompt-caching pipeline, and the cost delta on
 * ~5k emails is acceptable for a one-shot job. Revisit Batch API if we
 * need to re-run frequently.
 *
 * Usage:
 *   npm run triage:bootstrap -- --dry-run --limit 50 --account topcoder1@gmail.com
 *   npm run triage:bootstrap -- --limit 5000 --account topcoder1@gmail.com
 */
import { classifyWithLlm } from '../src/triage/classifier.js';
import { recordSkip } from '../src/triage/prefilter.js';
import { recordExample } from '../src/triage/examples.js';
import { SUPERPILOT_API_URL, NANOCLAW_SERVICE_TOKEN } from '../src/config.js';
import { TRIAGE_DEFAULTS } from '../src/triage/config.js';
import { logger } from '../src/logger.js';

interface CliArgs {
  dryRun: boolean;
  limit: number;
  account: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    limit: 5000,
    account: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--limit') {
      const v = argv[++i];
      if (!v) throw new Error('--limit requires a value');
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer (got: ${v})`);
      }
      args.limit = n;
    } else if (a === '--account') {
      const v = argv[++i];
      if (!v) throw new Error('--account requires a value');
      args.account = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  const msg = [
    'Usage: npm run triage:bootstrap -- [options]',
    '',
    'Options:',
    '  --dry-run              Print decisions without writing to DB',
    '  --limit <n>            Max emails to process (default 5000)',
    '  --account <email>      Filter by account email',
    '  --help, -h             Show this help',
    '',
    'Env required: ANTHROPIC_API_KEY, NANOCLAW_SERVICE_TOKEN, SUPERPILOT_API_URL',
  ].join('\n');
  process.stdout.write(msg + '\n');
}

interface TriagedEmailRow {
  id: string;
  threadId: string;
  messageId?: string;
  account: string;
  sender: string;
  subject: string;
  body: string;
  superpilotLabel: string | null;
  status: 'archived' | 'inbox' | string;
  actedAt?: string;
}

async function fetchTriagedEmails(
  args: CliArgs,
): Promise<TriagedEmailRow[]> {
  if (!NANOCLAW_SERVICE_TOKEN) {
    throw new Error(
      'NANOCLAW_SERVICE_TOKEN is empty — cannot authenticate to SuperPilot',
    );
  }
  const base = SUPERPILOT_API_URL.replace(/\/$/, '');
  const url = new URL(`${base}/nanoclaw/triaged-emails`);
  url.searchParams.set('limit', String(args.limit));
  url.searchParams.set('status', 'archived');
  if (args.account) url.searchParams.set('account', args.account);
  // since: 90 days back — enough history without overwhelming the endpoint.
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  url.searchParams.set('since', since);

  const token = NANOCLAW_SERVICE_TOKEN.split(',')[0].split('@')[0].trim();
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SuperPilot returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as
    | { emails?: TriagedEmailRow[] }
    | TriagedEmailRow[];
  const rows = Array.isArray(json) ? json : (json.emails ?? []);
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Stats {
  total: number;
  classified: number;
  agreements: number;
  disagreements: number;
  malformed: number;
  skipRecorded: number;
  skipPromoted: number;
  examplesRecorded: number;
  errors: number;
}

async function run(args: CliArgs): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  process.stdout.write(
    `Fetching up to ${args.limit} archived emails` +
      (args.account ? ` for ${args.account}` : '') +
      ` (dry-run=${args.dryRun})...\n`,
  );

  const emails = await fetchTriagedEmails(args);
  process.stdout.write(`Fetched ${emails.length} emails.\n`);

  const stats: Stats = {
    total: emails.length,
    classified: 0,
    agreements: 0,
    disagreements: 0,
    malformed: 0,
    skipRecorded: 0,
    skipPromoted: 0,
    examplesRecorded: 0,
    errors: 0,
  };

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    try {
      const result = await classifyWithLlm({
        emailBody: e.body ?? '',
        sender: e.sender,
        subject: e.subject ?? '',
        superpilotLabel: e.superpilotLabel ?? null,
        threadId: e.threadId ?? e.id,
        account: e.account,
      });
      stats.classified++;

      // The user archived this email; classifier agrees when it says
      // archive_candidate (or ignore).
      const userQueue = 'archive_candidate';
      const agentQueue = result.decision.queue;
      const agreed =
        agentQueue === 'archive_candidate' || agentQueue === 'ignore';

      if (agreed) {
        stats.agreements++;
        if (args.dryRun) {
          process.stdout.write(
            `[${i + 1}/${emails.length}] AGREE  ${e.sender} → ${agentQueue} (conf=${result.decision.confidence.toFixed(2)})\n`,
          );
        } else {
          const r = recordSkip(e.sender, TRIAGE_DEFAULTS.skiplistPromotionHits);
          stats.skipRecorded++;
          if (r.promoted) stats.skipPromoted++;
          recordExample({
            kind: 'positive',
            trackedItemId: e.id,
            emailSummary: `${e.subject} — from ${e.sender}`.slice(0, 500),
            agentQueue,
            userQueue,
            reasons: result.decision.reasons,
          });
          stats.examplesRecorded++;
        }
      } else {
        stats.disagreements++;
        if (args.dryRun) {
          process.stdout.write(
            `[${i + 1}/${emails.length}] DISAGREE ${e.sender} → agent=${agentQueue} user=archived (conf=${result.decision.confidence.toFixed(2)})\n`,
          );
        } else {
          recordExample({
            kind: 'negative',
            trackedItemId: e.id,
            emailSummary: `${e.subject} — from ${e.sender}`.slice(0, 500),
            agentQueue,
            userQueue,
            reasons: result.decision.reasons,
          });
          stats.examplesRecorded++;
        }
      }
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (/malformed/i.test(msg)) stats.malformed++;
      logger.warn({ emailId: e.id, err: msg }, 'triage-bootstrap: classify failed');
    }

    // 200ms between calls; prompt caching handles the bulk of cost.
    await sleep(200);
  }

  process.stdout.write('\n--- Summary ---\n');
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }
  await run(args);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
