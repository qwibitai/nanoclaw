#!/usr/bin/env tsx
/**
 * deal-watch.ts — DRY RUN
 *
 * Pulls high-value deals from HubSpot and cross-references with Gong calls
 * to surface three signals:
 *   1) New-deal momentum  (open deals >= $200K with positive Gong activity)
 *   2) New-deal at-risk   (open deals >= $200K with silence or risk keywords)
 *   3) Churn risk         (open Renewals >= $50K in active-risk stages)
 *
 * Prints what *would* alert. No Telegram, no state, no dedupe yet.
 *
 * Run:  tsx scripts/deal-watch.ts
 */

import { execFileSync } from 'child_process';

// ─── Config ──────────────────────────────────────────────────────────────────

const NEW_DEAL_THRESHOLD = 200_000;
const CHURN_THRESHOLD = 50_000;
const LOOKBACK_DAYS = 60; // wide enough for monthly-cadence renewals
const SILENCE_DAYS = 21; // for new deals with prior calls

// HubSpot pipelines that count as "real new business" (Renewals excluded by design)
const NEW_BUSINESS_PIPELINES = [
  '1142765', // Market Demand
  '1142761', // Account Management
  'default', // Strategic & Channel
  '160077710', // Attaxion
  '1933638', // APAC Team
  '10496653', // NAF
];

const RENEWALS_PIPELINE = '1149334';

// Renewal stages that represent ACTIVE churn risk (not forward-dated placeholders)
const ACTIVE_CHURN_STAGES = [
  '1149339', // Past Due Renewal
  '1159484', // Renegotiation
  '1178116007', // Rep managed
];

// Gong tracker categories (configured in your Gong workspace).
// Any hit on a risk tracker = potential trouble. Any hit on a momentum tracker = lean in.
const RISK_TRACKERS = ['Customer concerns', 'Customer objections', 'Reactions to pricing'];
const MOMENTUM_TRACKERS = ['Sandler - Upfront Contracts', 'Strategic business goals'];
const JUDGMENTAL_TONE_THRESHOLD = 8; // hits per call before flagging

// ─── Secret loading ──────────────────────────────────────────────────────────

function getSecret(name: string): string {
  try {
    const out = execFileSync(
      'uv',
      ['run', '--directory', `${process.env.HOME}/dev/wxa-secrets`, 'python', '-m', 'wxa_secrets', 'get', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim();
  } catch {
    throw new Error(`Missing secret: ${name}`);
  }
}

const HUBSPOT_TOKEN = getSecret('HUBSPOT_PRIVATE_APP_TOKEN');
const GONG_KEY = getSecret('GONG_API_ACCESS_KEY');
const GONG_SECRET = getSecret('GONG_API_ACCESS_KEY_SECRET');
const GONG_BASE = getSecret('GONG_API_BASE_URL');
const GONG_AUTH = 'Basic ' + Buffer.from(`${GONG_KEY}:${GONG_SECRET}`).toString('base64');

// ─── Types ───────────────────────────────────────────────────────────────────

type HsDeal = {
  id: string;
  name: string;
  amount: number;
  pipeline: string;
  stage: string;
  closeDate: string | null;
  companyName: string | null;
  companyDomain: string | null;
};

type GongCall = {
  id: string;
  title: string;
  started: string; // ISO
  externalDomains: string[];
  trackers: { name: string; count: number }[];
};

type Signals = {
  callCount: number;
  daysSinceLastCall: number | null;
  riskTrackerHits: string[]; // tracker names that fired
  momentumTrackerHits: string[];
  highTone: boolean; // judgmental tone above threshold
  matchedCallTitles: string[];
};

// ─── HubSpot ─────────────────────────────────────────────────────────────────

async function searchHubspot(body: object): Promise<{ results: any[]; total: number }> {
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HubSpot ${r.status}: ${await r.text()}`);
  return r.json() as Promise<{ results: any[]; total: number }>;
}

// Batch deal→company associations + company details in 2 API calls instead of 2*N.
async function enrichWithCompanies(deals: Omit<HsDeal, 'companyName' | 'companyDomain'>[]): Promise<HsDeal[]> {
  if (deals.length === 0) return [];
  // Step 1: batch associations
  const ar = await fetch('https://api.hubapi.com/crm/v4/associations/deals/companies/batch/read', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: deals.map((d) => ({ id: d.id })) }),
  });
  const adata = (await ar.json()) as { results?: { from: { id: string }; to: { toObjectId: number | string }[] }[] };
  const dealToCompanyId = new Map<string, string>();
  for (const r of adata.results ?? []) {
    const cid = r.to?.[0]?.toObjectId;
    if (cid != null) dealToCompanyId.set(String(r.from.id), String(cid));
  }

  // Step 2: batch company reads
  const companyIds = [...new Set(dealToCompanyId.values())];
  const companyMap = new Map<string, { name: string | null; domain: string | null }>();
  if (companyIds.length > 0) {
    const cr = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: ['name', 'domain'],
        inputs: companyIds.map((id) => ({ id })),
      }),
    });
    const cdata = (await cr.json()) as { results?: { id: string; properties: { name?: string; domain?: string } }[] };
    for (const c of cdata.results ?? []) {
      companyMap.set(c.id, { name: c.properties.name ?? null, domain: c.properties.domain ?? null });
    }
  }

  return deals.map((d) => {
    const cid = dealToCompanyId.get(d.id);
    const c = cid ? companyMap.get(cid) : null;
    return { ...d, companyName: c?.name ?? null, companyDomain: c?.domain ?? null };
  });
}

async function getNewDealCandidates(): Promise<HsDeal[]> {
  // HubSpot search caps at 5 filterGroups; use IN operator for pipelines instead.
  const data = await searchHubspot({
    filterGroups: [
      {
        filters: [
          { propertyName: 'amount', operator: 'GTE', value: String(NEW_DEAL_THRESHOLD) },
          { propertyName: 'pipeline', operator: 'IN', values: NEW_BUSINESS_PIPELINES },
          { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
        ],
      },
    ],
    properties: ['dealname', 'amount', 'pipeline', 'dealstage', 'closedate'],
    limit: 100,
  });
  const stubs = data.results.map((r: any) => ({
    id: r.id,
    name: r.properties.dealname ?? '(no name)',
    amount: parseFloat(r.properties.amount ?? '0'),
    pipeline: r.properties.pipeline,
    stage: r.properties.dealstage,
    closeDate: r.properties.closedate ?? null,
  }));
  return enrichWithCompanies(stubs);
}

async function getChurnCandidates(): Promise<HsDeal[]> {
  const data = await searchHubspot({
    filterGroups: [
      {
        filters: [
          { propertyName: 'amount', operator: 'GTE', value: String(CHURN_THRESHOLD) },
          { propertyName: 'pipeline', operator: 'EQ', value: RENEWALS_PIPELINE },
          { propertyName: 'dealstage', operator: 'IN', values: ACTIVE_CHURN_STAGES },
          { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
        ],
      },
    ],
    properties: ['dealname', 'amount', 'pipeline', 'dealstage', 'closedate'],
    limit: 100,
  });
  const stubs = data.results.map((r: any) => ({
    id: r.id,
    name: r.properties.dealname ?? '(no name)',
    amount: parseFloat(r.properties.amount ?? '0'),
    pipeline: r.properties.pipeline,
    stage: r.properties.dealstage,
    closeDate: r.properties.closedate ?? null,
  }));
  return enrichWithCompanies(stubs);
}

// ─── Gong ────────────────────────────────────────────────────────────────────

async function fetchGongCalls(sinceIso: string): Promise<GongCall[]> {
  const calls: GongCall[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filter: { fromDateTime: sinceIso },
      contentSelector: {
        exposedFields: { parties: true, content: { trackers: true } },
      },
    };
    if (cursor) body.cursor = cursor;
    const r = await fetch(`${GONG_BASE}/calls/extensive`, {
      method: 'POST',
      headers: { Authorization: GONG_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (r.status === 404) return calls;
      throw new Error(`Gong ${r.status}: ${await r.text()}`);
    }
    const data = (await r.json()) as {
      calls?: {
        metaData: { id: string; title: string; started: string; scope: string };
        parties?: { emailAddress?: string; affiliation?: string }[];
        content?: { trackers?: { name: string; count: number }[] };
      }[];
      records?: { cursor?: string };
    };
    for (const c of data.calls ?? []) {
      // External calls only — internal pitch trainings, all-hands, etc. are noise.
      if (c.metaData.scope !== 'External') continue;
      const externalDomains = (c.parties ?? [])
        .filter((p) => p.affiliation === 'External' && p.emailAddress?.includes('@'))
        .map((p) => p.emailAddress!.split('@')[1].toLowerCase());
      calls.push({
        id: c.metaData.id,
        title: c.metaData.title ?? '',
        started: c.metaData.started,
        externalDomains: [...new Set(externalDomains)],
        trackers: (c.content?.trackers ?? []).filter((t) => t.count > 0),
      });
    }
    cursor = data.records?.cursor;
  } while (cursor);
  return calls;
}

function matchCallsToDeal(deal: HsDeal, allCalls: GongCall[]): GongCall[] {
  const domain = deal.companyDomain?.toLowerCase().trim();
  if (!domain) return [];
  // Match the registrable part so subdomains/regional TLDs still match.
  // e.g. deal "ibm.com" matches call party "@us.ibm.com".
  const root = domain.split('.').slice(-2).join('.');
  return allCalls.filter((c) =>
    c.externalDomains.some((d) => d === domain || d.endsWith('.' + domain) || d.endsWith('.' + root) || d === root),
  );
}

function computeSignals(calls: GongCall[]): Signals {
  if (calls.length === 0) {
    return {
      callCount: 0,
      daysSinceLastCall: null,
      riskTrackerHits: [],
      momentumTrackerHits: [],
      highTone: false,
      matchedCallTitles: [],
    };
  }
  const sorted = [...calls].sort((a, b) => b.started.localeCompare(a.started));
  const lastMs = new Date(sorted[0].started).getTime();
  const days = Math.floor((Date.now() - lastMs) / 86_400_000);

  const riskHits = new Set<string>();
  const momHits = new Set<string>();
  let highTone = false;
  for (const c of calls) {
    for (const t of c.trackers) {
      if (RISK_TRACKERS.includes(t.name)) riskHits.add(t.name);
      if (MOMENTUM_TRACKERS.includes(t.name)) momHits.add(t.name);
      if (t.name === 'Judgmental Tone' && t.count >= JUDGMENTAL_TONE_THRESHOLD) highTone = true;
    }
  }

  return {
    callCount: calls.length,
    daysSinceLastCall: days,
    riskTrackerHits: [...riskHits],
    momentumTrackerHits: [...momHits],
    highTone,
    matchedCallTitles: sorted.slice(0, 3).map((c) => c.title),
  };
}

// ─── Triggers ────────────────────────────────────────────────────────────────

type Alert = { kind: 'momentum' | 'at-risk' | 'churn'; deal: HsDeal; signals: Signals; reasons: string[] };

function evaluateNewDeal(deal: HsDeal, s: Signals): Alert | null {
  const hasMomentum = s.momentumTrackerHits.length > 0 || s.callCount >= 3;
  const hasRisk = s.riskTrackerHits.length > 0 || s.highTone;
  const wentSilent = s.callCount > 0 && s.daysSinceLastCall !== null && s.daysSinceLastCall > SILENCE_DAYS;

  // Momentum path — positive activity worth leaning into. Surface co-occurring risks.
  if (hasMomentum) {
    const reasons: string[] = [];
    if (s.momentumTrackerHits.length) reasons.push(`+${s.momentumTrackerHits.join(', ')}`);
    if (s.callCount >= 3) reasons.push(`${s.callCount} calls/${LOOKBACK_DAYS}d`);
    if (s.riskTrackerHits.length) reasons.push(`⚠ ${s.riskTrackerHits.join(', ')}`);
    if (s.highTone) reasons.push(`⚠ high tone`);
    return { kind: 'momentum', deal, signals: s, reasons };
  }

  // At-risk path — only fire on real negative signals from calls that DID happen.
  // Pure silence is the default state of B2B pipelines (creates noise).
  if (hasRisk || wentSilent) {
    const reasons: string[] = [];
    if (s.riskTrackerHits.length) reasons.push(`trackers: ${s.riskTrackerHits.join(', ')}`);
    if (s.highTone) reasons.push(`high judgmental tone`);
    if (wentSilent) reasons.push(`silent ${s.daysSinceLastCall}d after ${s.callCount} calls`);
    return { kind: 'at-risk', deal, signals: s, reasons };
  }

  return null;
}

function evaluateChurn(deal: HsDeal, s: Signals): Alert {
  const reasons: string[] = [`active-risk stage`];
  if (s.callCount === 0) reasons.push(`no Gong calls in ${LOOKBACK_DAYS}d`);
  else if (s.daysSinceLastCall !== null && s.daysSinceLastCall > SILENCE_DAYS)
    reasons.push(`silent ${s.daysSinceLastCall}d`);
  if (s.riskTrackerHits.length) reasons.push(`trackers: ${s.riskTrackerHits.join(', ')}`);
  if (s.highTone) reasons.push(`high judgmental tone`);
  return { kind: 'churn', deal, signals: s, reasons };
}

// ─── Output ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function printAlerts(title: string, alerts: Alert[]): void {
  console.log(`\n=== ${title} (${alerts.length}) ===`);
  if (alerts.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const a of alerts.sort((x, y) => y.deal.amount - x.deal.amount)) {
    console.log(
      `  ${fmtMoney(a.deal.amount).padStart(12)}  ${a.deal.name.slice(0, 60).padEnd(60)}  → ${a.reasons.join('; ')}`,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

type DealWatchResult = {
  momentum: Alert[];
  atRisk: Alert[];
  churn: Alert[];
  candidateCounts: { newDeals: number; churn: number; gongCalls: number };
};

async function runDealWatch(): Promise<DealWatchResult> {
  const [newDeals, churnDeals] = await Promise.all([getNewDealCandidates(), getChurnCandidates()]);
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const calls = await fetchGongCalls(sinceIso);

  const momentum: Alert[] = [];
  const atRisk: Alert[] = [];
  for (const d of newDeals) {
    const matched = matchCallsToDeal(d, calls);
    const signals = computeSignals(matched);
    const alert = evaluateNewDeal(d, signals);
    if (alert?.kind === 'momentum') momentum.push(alert);
    if (alert?.kind === 'at-risk') atRisk.push(alert);
  }

  const churn: Alert[] = [];
  for (const d of churnDeals) {
    const matched = matchCallsToDeal(d, calls);
    const signals = computeSignals(matched);
    churn.push(evaluateChurn(d, signals));
  }

  return {
    momentum,
    atRisk,
    churn,
    candidateCounts: {
      newDeals: newDeals.length,
      churn: churnDeals.length,
      gongCalls: calls.length,
    },
  };
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes('--json');

  if (!jsonMode) console.log('Fetching HubSpot candidates + Gong calls…');
  const result = await runDealWatch();

  if (jsonMode) {
    // Machine-readable output for deal-watch-loop.ts
    process.stdout.write(JSON.stringify(result));
    return;
  }

  console.log(`  new-deal candidates: ${result.candidateCounts.newDeals}`);
  console.log(`  churn candidates:    ${result.candidateCounts.churn}`);
  console.log(`  Gong calls in window: ${result.candidateCounts.gongCalls}`);

  printAlerts('NEW-DEAL MOMENTUM (≥$200K, lean in)', result.momentum);
  printAlerts('NEW-DEAL AT-RISK (≥$200K, risk signals)', result.atRisk);
  printAlerts('CHURN RISK (≥$50K Renewals, active-risk stages)', result.churn);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
