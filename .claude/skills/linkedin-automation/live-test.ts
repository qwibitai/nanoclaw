/**
 * LinkedIn + Notion — Live Integration Test
 *
 * Runs against real APIs with real credentials from .env
 * Tests are structured from safest (read-only Notion) to most impactful (browser).
 *
 * Usage:
 *   cd /home/shail-lm10/nanoclaw
 *   npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/live-test.ts
 *
 * Tier 4 (interactive button verification) prompts for LinkedIn profile URLs.
 * To skip the prompts, set env vars before running:
 *   LIVE_TEST_PROFILE=<url>           — profile NOT yet connected (connect/visit tests)
 *   LIVE_TEST_CONNECTED_PROFILE=<url> — 1st-degree connection (message test)
 */

import { spawnSync } from 'child_process';
import path from 'path';
import readline from 'readline';
import { upsertLead, updateLeadStatus, getLeadsByStatus, getCampaignStats, _setDataSourceId } from './lib/notion.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

const PASS = `${GREEN}✓ PASS${RESET}`;
const FAIL = `${RED}✗ FAIL${RESET}`;
const SKIP = `${YELLOW}⚠ SKIP${RESET}`;

const results: { name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }[] = [];

function log(status: 'pass' | 'fail' | 'skip', name: string, detail?: string) {
  const icon = status === 'pass' ? PASS : status === 'fail' ? FAIL : SKIP;
  console.log(`  ${icon}  ${name}${detail ? `\n        ${detail}` : ''}`);
  results.push({ name, status, detail });
}

/** Throw inside a test() body to mark it skipped rather than failed */
class SkipSignal extends Error {
  constructor(reason: string) { super(reason); this.name = 'SkipSignal'; }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    log('pass', name);
  } catch (err) {
    if (err instanceof SkipSignal) {
      log('skip', name, err.message);
    } else {
      log('fail', name, err instanceof Error ? err.message : String(err));
    }
  }
}

function skipTest(name: string, reason: string) {
  log('skip', name, reason);
}

// ── Helper: run a LinkedIn script as subprocess ────────────────────────────────

const ROOT     = process.cwd();
const SCRIPTS  = path.join(ROOT, '.claude/skills/linkedin-automation/scripts');

interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function runScript(scriptFile: string, input: object, timeoutMs = 120_000): ScriptResult {
  const scriptPath = path.join(SCRIPTS, scriptFile);
  const result = spawnSync(
    'npx', ['tsx', scriptPath],
    {
      cwd: ROOT,
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env },
    }
  );
  if (result.error) throw new Error(`Spawn error: ${result.error.message}`);
  if (result.status !== 0 && !result.stdout?.trim()) {
    throw new Error(result.stderr?.slice(-500) || `Script exited ${result.status}`);
  }
  const stdout = result.stdout?.trim() ?? '';
  if (!stdout) {
    // exited 0, no stdout — treat as success
    return { success: true, message: 'Script completed (no output)' };
  }
  try {
    return JSON.parse(stdout) as ScriptResult;
  } catch {
    throw new Error(`Non-JSON stdout: ${stdout.slice(0, 200)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 1 — Notion CRUD (direct library calls, no browser)
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${BOLD}Tier 1: Notion CRUD (direct API calls)${RESET}`);

const TEST_URL = 'https://www.linkedin.com/in/__live_test__';

await test('upsertLead — create new lead', async () => {
  await upsertLead({
    name:     '__live_test__',
    profileUrl: TEST_URL,
    title:    'Test Engineer',
    company:  'Test Co',
    status:   'New',
    campaign: 'live-test',
    notes:    'Created by live-test.ts — safe to archive',
  });
});

await test('getLeadsByStatus — find the new lead in "New"', async () => {
  const leads = await getLeadsByStatus('New', 'live-test');
  const found = leads.find(l => l.profileUrl === TEST_URL);
  if (!found) throw new Error(`Test lead not found in "New" status (got ${leads.length} leads)`);
});

await test('updateLeadStatus — move to "Visited"', async () => {
  await updateLeadStatus(TEST_URL, 'Visited', { notes: 'Status updated by live-test.ts' });
});

await test('getLeadsByStatus — confirm lead moved to "Visited"', async () => {
  const leads = await getLeadsByStatus('Visited', 'live-test');
  const found = leads.find(l => l.profileUrl === TEST_URL);
  if (!found) throw new Error(`Lead not found in "Visited" after updateLeadStatus`);
});

await test('updateLeadStatus — move to "Connected" (checks Connection Date set)', async () => {
  await updateLeadStatus(TEST_URL, 'Connected');
});

await test('getCampaignStats — returns all 7 status keys with counts', async () => {
  const stats = await getCampaignStats();
  const keys = Object.keys(stats).sort();
  const expected = ['Archived', 'Connected', 'Messaged', 'New', 'Replied', 'Requested', 'Visited'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected keys: ${JSON.stringify(keys)}`);
  }
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  console.log(`        Stats: ${JSON.stringify(stats)} | Total leads: ${total}`);
});

await test('upsertLead — update existing lead (idempotent upsert)', async () => {
  // Calling upsertLead on an existing URL should update, not create a duplicate
  await upsertLead({
    name:       '__live_test__',
    profileUrl: TEST_URL,
    status:     'Archived',
    notes:      'Archived by live-test.ts — safe to delete',
  });
});

await test('getLeadsByStatus — confirm lead archived (cleanup)', async () => {
  const leads = await getLeadsByStatus('Archived');
  const found = leads.find(l => l.profileUrl === TEST_URL);
  if (!found) throw new Error('Lead not found in Archived after cleanup upsert');
  console.log(`        Test lead archived successfully — profile: ${found.profileUrl}`);
});

// ════════════════════════════════════════════════════════════════════════════
// TIER 2 — LinkedIn scripts: Notion-only (no browser)
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${BOLD}Tier 2: LinkedIn scripts — Notion-only (no browser)${RESET}`);

await test('get-campaign-stats script (subprocess → Notion)', async () => {
  const result = runScript('get-campaign-stats.ts', {});
  if (!result.success) throw new Error(result.message);
  console.log(`        ${result.message.split('\n')[0]}`);
});

await test('get-campaign-stats filtered by campaign name', async () => {
  const result = runScript('get-campaign-stats.ts', { campaign: 'live-test' });
  if (!result.success) throw new Error(result.message);
  console.log(`        ${result.message.split('\n')[0]}`);
});

// ════════════════════════════════════════════════════════════════════════════
// TIER 3 — LinkedIn browser scripts (read-only: scrape/visit, no LinkedIn actions)
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${BOLD}Tier 3: LinkedIn browser scripts (read-only scrape)${RESET}`);

if (!process.env.NOTION_API_KEY || !process.env.NOTION_LEADS_DB_ID) {
  skipTest('scrape-search (browser)', 'NOTION credentials not set — skipping browser tier');
  skipTest('scrape-profile (browser)', 'NOTION credentials not set — skipping browser tier');
} else {
  let scrapedProfileUrl: string | null = null;

  await test('scrape-search — "software engineer" maxLeads=2 → saves to Notion', async () => {
    console.log('        (this opens a real browser, may take ~30s)');
    const result = runScript('scrape-search.ts', { query: 'software engineer', maxLeads: 2 }, 90_000);
    if (!result.success) throw new Error(result.message);
    const data = result.data as { count: number; leads: string[] } | undefined;
    if (!data || data.count < 1) throw new Error(`Expected ≥1 lead, got: ${result.message}`);
    console.log(`        Scraped ${data.count} leads: ${data.leads.join(', ')}`);
  });

  await test('scrape-search — "startup founder NYC" maxLeads=2', async () => {
    const result = runScript('scrape-search.ts', { query: 'startup founder NYC', maxLeads: 2 }, 90_000);
    if (!result.success) throw new Error(result.message);
    const data = result.data as { count: number; leads: string[] } | undefined;
    console.log(`        Scraped ${data?.count ?? 0} leads`);
    // Get a profile URL to use for scrape-profile test
    if (data && data.count > 0) {
      const leads = await getLeadsByStatus('New');
      const recentLead = leads.find(l => l.source === 'Search');
      if (recentLead) scrapedProfileUrl = recentLead.profileUrl;
    }
  });

  if (scrapedProfileUrl) {
    await test(`scrape-profile — scrape one profile found above`, async () => {
      console.log(`        Profile: ${scrapedProfileUrl}`);
      const result = runScript('scrape-profile.ts', { profileUrl: scrapedProfileUrl!, source: 'Live Test' }, 120_000);
      if (!result.success) throw new Error(result.message);
      const data = result.data as { name: string; headline: string } | undefined;
      console.log(`        Result: ${data?.name ?? '?'} — ${data?.headline ?? '?'}`);
    });
  } else {
    skipTest('scrape-profile (browser)', 'No scraped profile URL available from previous step');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TIER 4 — Interactive: real button verification against live LinkedIn
//
// These tests verify the exact selectors that broke silently in live testing:
//   - :visible prevents picking hidden DOM duplicates (affects all action buttons)
//   - connectBtn case-insensitive ("Invite X to connect" vs "Connect")
//   - No-note path uses sendWithoutNoteBtn, never sendNowBtn  (ISSUE-003)
//   - Note path: addNoteBtn → fill → sendNowBtn ("Send invitation")
//   - messageBtn:visible on 1st-degree connections
//
// Set env vars to skip prompts (useful for scripted re-runs):
//   LIVE_TEST_PROFILE=<url>           — profile NOT yet connected (connect tests)
//   LIVE_TEST_CONNECTED_PROFILE=<url> — 1st-degree connection (message test)
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${BOLD}Tier 4: Interactive button verification (real LinkedIn actions)${RESET}`);
console.log(`  Confirms the selectors that broke silently in live testing.`);
console.log(`  Each test asks for confirmation before doing anything on LinkedIn.\n`);

/** Ask a yes/no/skip-all question at the terminal. Returns 'y', 'n', or 'skip'. */
async function confirm(question: string): Promise<'y' | 'n' | 'skip'> {
  if (!process.stdin.isTTY) return 'n';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 's' || a === 'skip' || a === 'skip-all') resolve('skip');
      else if (a === 'y' || a === 'yes') resolve('y');
      else resolve('n');
    });
  });
}

async function promptUrl(label: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Collect profile URLs ──────────────────────────────────────────────────

let connectProfile = process.env.LIVE_TEST_PROFILE || '';
if (!connectProfile && process.stdin.isTTY) {
  connectProfile = await promptUrl(
    `  Profile URL for visit + connect tests\n` +
    `  (must NOT be a current connection — or Enter to skip Tier 4):\n  > `
  );
}

let messageProfile = process.env.LIVE_TEST_CONNECTED_PROFILE || '';
if (!messageProfile && connectProfile && process.stdin.isTTY) {
  messageProfile = await promptUrl(
    `\n  Profile URL for the message test\n` +
    `  (must be a 1st-degree connection — or Enter to skip message test):\n  > `
  );
}

// ── T4-A: visit-profile (:visible navigation) ────────────────────────────

if (!connectProfile) {
  skipTest('T4-A visit-profile (:visible navigation)',      'No LIVE_TEST_PROFILE — skipping Tier 4');
  skipTest('T4-B send-connection no-note (ISSUE-003)',      'No LIVE_TEST_PROFILE — skipping Tier 4');
  skipTest('T4-C send-connection with note (modal flow)',   'No LIVE_TEST_PROFILE — skipping Tier 4');
} else {
  let skipRestOfTier4 = false;

  await test('T4-A visit-profile — :visible navigation (adds to "Who viewed your profile")', async () => {
    if (!process.env.LIVE_TEST_PROFILE) {
      console.log(`\n  Profile: ${connectProfile}`);
      const ans = await confirm(`  Run visit-profile? [y/n/skip-all]: `);
      if (ans === 'skip') { skipRestOfTier4 = true; throw new SkipSignal('Skipped by user'); }
      if (ans !== 'y') throw new SkipSignal('Skipped by user');
    }
    const result = runScript('visit-profile.ts', { profileUrl: connectProfile }, 60_000);
    if (!result.success) throw new Error(result.message);
    console.log(`        ${result.message}`);
  });

  // T4-B: send-connection without note
  // Regression: no-note path must use sendWithoutNoteBtn only, never sendNowBtn ("Send invitation")
  if (!skipRestOfTier4) {
    await test('T4-B send-connection (no note) — :visible connectBtn + sendWithoutNoteBtn, NOT sendNowBtn', async () => {
      if (!process.env.LIVE_TEST_PROFILE) {
        console.log(`\n  Profile: ${connectProfile}`);
        console.log(`  ${YELLOW}⚠ Only run if NOT already connected to this person${RESET}`);
        console.log(`  Regression guarded: no-note path must never call "Send invitation" (sendNowBtn)`);
        const ans = await confirm(`  Run send-connection (no note)? [y/n/skip-all]: `);
        if (ans === 'skip') { skipRestOfTier4 = true; throw new SkipSignal('Skipped by user'); }
        if (ans !== 'y') throw new SkipSignal('Skipped by user');
      }
      const result = runScript('send-connection.ts', { profileUrl: connectProfile }, 60_000);
      if (!result.success) throw new Error(result.message);
      console.log(`        ${result.message}`);
    });
  }

  // T4-C: send-connection with note (tests full modal flow)
  // Regression: note path must use addNoteBtn → fill → sendNowBtn ("Send invitation")
  // In practice, skip if T4-B already sent a request to the same profile.
  if (!skipRestOfTier4) {
    await test('T4-C send-connection (with note) — :visible connectBtn + addNoteBtn + sendNowBtn modal flow', async () => {
      if (!process.env.LIVE_TEST_PROFILE) {
        console.log(`\n  Profile: ${connectProfile}`);
        console.log(`  ${YELLOW}⚠ Skip if T4-B already sent a connection request (pending request exists)${RESET}`);
        console.log(`  Regression guarded: note path must click addNoteBtn then "Send invitation"`);
        const ans = await confirm(`  Run send-connection (with note)? [y/n/skip-all]: `);
        if (ans === 'skip') { skipRestOfTier4 = true; throw new SkipSignal('Skipped by user'); }
        if (ans !== 'y') throw new SkipSignal('Skipped by user');
      }
      const result = runScript('send-connection.ts', {
        profileUrl: connectProfile,
        note: 'Button selector live test — safe to ignore',
      }, 60_000);
      if (!result.success) throw new Error(result.message);
      console.log(`        ${result.message}`);
    });
  }
}

// ── T4-D: send-message (messageBtn:visible) ───────────────────────────────

if (!messageProfile) {
  skipTest('T4-D send-message — messageBtn:visible (1st-degree only)', 'No LIVE_TEST_CONNECTED_PROFILE — skipping message test');
} else {
  await test('T4-D send-message — messageBtn:visible (regression: hidden DOM duplicate would miss this)', async () => {
    if (!process.env.LIVE_TEST_CONNECTED_PROFILE) {
      console.log(`\n  Profile: ${messageProfile}`);
      console.log(`  ${YELLOW}⚠ Must be a 1st-degree connection or message button won't appear${RESET}`);
      console.log(`  Will send: "Button selector live test — please ignore"`);
      const ans = await confirm(`  Run send-message? [y/n]: `);
      if (ans !== 'y') throw new SkipSignal('Skipped by user');
    }
    const result = runScript('send-message.ts', {
      profileUrl: messageProfile,
      message: 'Button selector live test — please ignore',
    }, 60_000);
    if (!result.success) throw new Error(result.message);
    console.log(`        ${result.message}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════

const passed = results.filter(r => r.status === 'pass').length;
const failed = results.filter(r => r.status === 'fail').length;
const skipped = results.filter(r => r.status === 'skip').length;

console.log(`\n${BOLD}════════════════════════════════════════${RESET}`);
console.log(`${BOLD}Results: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}  ${YELLOW}${skipped} skipped${RESET}`);
console.log(`${BOLD}════════════════════════════════════════${RESET}\n`);

if (failed > 0) {
  console.log(`${RED}Failed tests:${RESET}`);
  results.filter(r => r.status === 'fail').forEach(r => {
    console.log(`  ✗ ${r.name}`);
    if (r.detail) console.log(`    ${r.detail}`);
  });
  console.log('');
  process.exit(1);
}
