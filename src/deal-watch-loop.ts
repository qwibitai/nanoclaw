/**
 * deal-watch-loop — background poller that surfaces high-value HubSpot deals
 * with actionable Gong signals and routes alerts to the main group.
 *
 * Architecture: this module does NOT carry HubSpot or Gong client code itself.
 * It spawns scripts/deal-watch.ts --json on an interval, parses the result,
 * dedupes via the existing processed_items table, and forwards only
 * new-or-changed alerts to the main group via the injected sendMessage.
 *
 * Dedupe strategy: each alert is hashed into a deal_id:signature key where
 * signature is a deterministic serialization of the reasons array. The same
 * alert re-fires only when something about it actually changes.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';

import { isItemProcessed, markItemProcessed } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Read a single flag from either process.env or the repo's .env file.
// readEnvFile intentionally does not populate process.env (security), so we
// look there manually. Cached across polls so we only parse .env once.
let envCache: Record<string, string> | null = null;
function readEnvFlag(key: string): string | undefined {
  if (envCache === null) envCache = readEnvFile([key]);
  return envCache[key];
}

// Poll cadence. Gong calls land in minutes, HubSpot stage changes in seconds.
// 15 minutes gives near-real-time feel without hammering either API.
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// Wait this long after startup before the first poll (lets channels connect).
const STARTUP_DELAY_MS = 30 * 1000;

type AlertKind = 'momentum' | 'at-risk' | 'churn';

type Alert = {
  kind: AlertKind;
  deal: {
    id: string;
    name: string;
    amount: number;
    companyName: string | null;
    companyDomain: string | null;
  };
  reasons: string[];
};

type DealWatchResult = {
  momentum: Alert[];
  atRisk: Alert[];
  churn: Alert[];
  candidateCounts: { newDeals: number; churn: number; gongCalls: number };
};

type Deps = {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
};

// Run the existing CLI dry-run script as a child process. Keeping the
// HubSpot/Gong code in one place (the script) avoids two copies drifting.
function runDealWatchScript(): Promise<DealWatchResult | null> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'deal-watch.ts');
    const child = spawn('npx', ['tsx', scriptPath, '--json'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Hard timeout at 3 min so a hung HubSpot/Gong request can't wedge the loop.
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      logger.warn('deal-watch script exceeded 3min, killed');
      resolve(null);
    }, 3 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        logger.warn(
          { code, stderr: stderr.slice(0, 500) },
          'deal-watch script exited non-zero',
        );
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as DealWatchResult;
        resolve(parsed);
      } catch (err) {
        logger.warn({ err, stdout: stdout.slice(0, 500) }, 'failed to parse deal-watch JSON');
        resolve(null);
      }
    });
  });
}

// Deterministic signature of an alert's material state. If this changes,
// the alert is meaningfully different and worth re-surfacing.
function alertSignature(a: Alert): string {
  const payload = JSON.stringify({
    kind: a.kind,
    amount: Math.round(a.deal.amount),
    reasons: [...a.reasons].sort(),
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function alertDedupeKey(a: Alert): string {
  return `deal-watch:${a.deal.id}:${alertSignature(a)}`;
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatAlert(a: Alert): string {
  const icon = a.kind === 'momentum' ? '🚀' : a.kind === 'at-risk' ? '⚠️' : '🔥';
  const label = a.kind === 'momentum' ? 'MOMENTUM' : a.kind === 'at-risk' ? 'AT RISK' : 'CHURN';
  const name = a.deal.name.length > 70 ? a.deal.name.slice(0, 67) + '…' : a.deal.name;
  return `${icon} *${label}* — ${fmtMoney(a.deal.amount)}\n${name}\n_${a.reasons.join(' · ')}_`;
}

function formatDigest(newAlerts: Alert[]): string {
  // Order: churn (most urgent) → at-risk → momentum, then by amount desc within each.
  const order: Record<AlertKind, number> = { churn: 0, 'at-risk': 1, momentum: 2 };
  const sorted = [...newAlerts].sort((x, y) => {
    const ko = order[x.kind] - order[y.kind];
    if (ko !== 0) return ko;
    return y.deal.amount - x.deal.amount;
  });
  const header =
    newAlerts.length === 1
      ? '📊 *Deal Watch* — 1 new signal'
      : `📊 *Deal Watch* — ${newAlerts.length} new signals`;
  return [header, '', ...sorted.map(formatAlert)].join('\n\n');
}

function findMainGroupJid(groups: Record<string, RegisteredGroup>): string | null {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return null;
}

async function pollOnce(deps: Deps): Promise<void> {
  const result = await runDealWatchScript();
  if (!result) return; // already logged

  // Flatten, dedupe, keep only ones we haven't alerted on with this signature.
  const all: Alert[] = [...result.momentum, ...result.atRisk, ...result.churn];
  const fresh: Alert[] = [];
  for (const a of all) {
    const key = alertDedupeKey(a);
    if (!isItemProcessed(key)) fresh.push(a);
  }

  logger.info(
    {
      candidates: result.candidateCounts,
      totalAlerts: all.length,
      freshAlerts: fresh.length,
    },
    'deal-watch poll complete',
  );

  if (fresh.length === 0) return;

  const jid = findMainGroupJid(deps.registeredGroups());
  if (!jid) {
    logger.warn('deal-watch: no main group registered, skipping send');
    return;
  }

  try {
    await deps.sendMessage(jid, formatDigest(fresh));
  } catch (err) {
    logger.warn({ err }, 'deal-watch: failed to send digest');
    return; // don't mark as processed if send failed — retry on next poll
  }

  // Mark as processed only after successful send
  const now = new Date().toISOString();
  for (const a of fresh) {
    markItemProcessed({
      item_id: alertDedupeKey(a),
      source: 'deal-watch',
      processed_at: now,
      action_taken: `sent:${a.kind}`,
    });
  }
}

export function startDealWatchLoop(deps: Deps): void {
  // Explicit opt-in. The child script loads its own credentials from the
  // wxa-secrets keychain, so the main process doesn't need them. Users
  // who don't want this feature get zero overhead by leaving the flag off.
  const enabled =
    process.env.DEAL_WATCH_ENABLED === '1' ||
    readEnvFlag('DEAL_WATCH_ENABLED') === '1';

  if (!enabled) {
    logger.debug('deal-watch loop disabled (set DEAL_WATCH_ENABLED=1 to enable)');
    return;
  }

  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'deal-watch loop starting');

  setTimeout(() => {
    void pollOnce(deps).catch((err) => logger.warn({ err }, 'deal-watch poll crashed'));
    setInterval(() => {
      void pollOnce(deps).catch((err) => logger.warn({ err }, 'deal-watch poll crashed'));
    }, POLL_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
