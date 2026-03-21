#!/usr/bin/env npx tsx
/**
 * progress-report.ts — Automated system progress report.
 *
 * Gathers PR/issue/test data mechanistically via gh CLI,
 * calls Claude API for narrative analysis, posts to GitHub Discussions.
 *
 * Usage:
 *   npx tsx scripts/progress-report.ts                    # generate and post
 *   npx tsx scripts/progress-report.ts --check-threshold  # exit 0 if ≥10 PRs, 1 if not
 *   npx tsx scripts/progress-report.ts --dry-run          # print report without posting
 *
 * Requires:
 *   ANTHROPIC_API_KEY — for Claude API narrative generation
 *   GH_TOKEN or gh CLI auth — for data gathering and posting
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────

const KAIZEN_REPO = 'Garsson-io/kaizen';
const NANOCLAW_REPO = 'Garsson-io/nanoclaw';
const DISCUSSION_CATEGORY_ID = 'DIC_kwDORof1pc4C49QK'; // Announcements
const PR_THRESHOLD = 10;
const REPORT_WINDOW_HOURS = 48; // look back 48h for data

// ── Data Gathering (mechanistic — no LLM) ───────────────────────────────

interface RawData {
  mergedPRs: Array<{ number: number; title: string; mergedAt: string }>;
  closedIssues: Array<{ number: number; title: string; closedAt: string }>;
  openIssueCount: number;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
  prBreakdown: Record<string, number>;
}

function gh(cmd: string): string {
  try {
    return execSync(`gh ${cmd}`, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) {
    console.error(`gh command failed: gh ${cmd.slice(0, 80)}`);
    return '';
  }
}

function getSinceDate(): string {
  const d = new Date(Date.now() - REPORT_WINDOW_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function gatherData(): RawData {
  const since = getSinceDate();
  console.log(`Gathering data since ${since}...`);

  // Merged PRs
  const prsJson = gh(
    `pr list --repo ${NANOCLAW_REPO} --state merged --search "merged:>=${since}" --json number,title,mergedAt --limit 100`,
  );
  const mergedPRs = prsJson
    ? JSON.parse(prsJson).sort(
        (a: any, b: any) =>
          new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime(),
      )
    : [];

  // Closed kaizen issues
  const issuesJson = gh(
    `issue list --repo ${KAIZEN_REPO} --state closed --search "closed:>=${since}" --json number,title,closedAt --limit 100`,
  );
  const closedIssues = issuesJson ? JSON.parse(issuesJson) : [];

  // Open issue count
  const openJson = gh(
    `issue list --repo ${KAIZEN_REPO} --state open --json number --limit 300`,
  );
  const openIssueCount = openJson ? JSON.parse(openJson).length : 0;

  // Diff stats (get the oldest merged PR's merge base)
  let diffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  if (mergedPRs.length > 0) {
    try {
      const shortstat = execSync(
        `git log --since="${since}" --shortstat --format="" | tail -1`,
        { encoding: 'utf8', timeout: 10_000 },
      ).trim();
      const filesMatch = shortstat.match(/(\d+) files? changed/);
      const insMatch = shortstat.match(/(\d+) insertions?/);
      const delMatch = shortstat.match(/(\d+) deletions?/);
      diffStats = {
        filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
        insertions: insMatch ? parseInt(insMatch[1]) : 0,
        deletions: delMatch ? parseInt(delMatch[1]) : 0,
      };
    } catch {
      // Git stats optional — may not be in a repo context in CI
    }
  }

  // PR type breakdown
  const prBreakdown: Record<string, number> = {};
  for (const pr of mergedPRs) {
    const match = pr.title.match(/^(\w+):/);
    const type = match ? match[1] : 'other';
    prBreakdown[type] = (prBreakdown[type] || 0) + 1;
  }

  return { mergedPRs, closedIssues, openIssueCount, diffStats, prBreakdown };
}

// ── Spirit docs (context for narrative voice) ───────────────────────────

function loadSpiritDocs(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, '..');
  const docs: string[] = [];

  const files = ['.claude/kaizen/zen.md', '.claude/kaizen/horizon.md'];

  for (const f of files) {
    try {
      const content = readFileSync(resolve(root, f), 'utf-8');
      docs.push(`### ${f}\n${content.slice(0, 2000)}`);
    } catch {
      // File not found — skip
    }
  }

  return docs.join('\n\n');
}

// ── Narrative Generation (Claude API) ───────────────────────────────────

async function generateNarrative(data: RawData): Promise<string> {
  // Use claude CLI with subscription auth (not raw API key).
  // The CLI is authed via CLAUDE_ACCESS_TOKEN in CI, or local OAuth.
  try {
    execSync('claude --version', { encoding: 'utf8', timeout: 5_000 });
  } catch {
    console.log('claude CLI not available — using template-only report');
    return generateTemplateReport(data);
  }

  const prList = data.mergedPRs
    .map((pr) => `#${pr.number}: ${pr.title}`)
    .join('\n');

  const spirit = loadSpiritDocs();

  const prompt = `You are the narrator of NanoClaw's kaizen journey — a system that improves itself through autonomous agents. Write a progress report that tells the STORY of what happened in the last 48 hours.

## Raw Data

**${data.mergedPRs.length} PRs merged:**
${prList}

**${data.closedIssues.length} kaizen issues closed**
**${data.openIssueCount} kaizen issues remaining open**
**Code: ${data.diffStats.filesChanged} files, +${data.diffStats.insertions}/-${data.diffStats.deletions} lines**
**PR breakdown:** ${Object.entries(data.prBreakdown)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')}

## Your task

Write a progress report that combines hard data with narrative storytelling. Include ALL PRs and issues with their numbers. But tell the STORY:

1. **The Numbers** — summary table with all metrics. Every PR listed with its number.

2. **The Story** — What was the arc of these 48 hours? What was the system trying to become? Group PRs into narrative threads (not just categories). Example: "The system learned to question its own assumptions" is more interesting than "5 hook fixes merged." Find the dramatic tension: what was broken, what the agents struggled with, what breakthrough connected the pieces.

3. **The Philosophy** — What does this period reveal about autonomous improvement? Reference specific PRs as evidence. Draw connections between seemingly unrelated changes. What pattern is emerging that the individual PRs don't see? Connect to the Zen of Kaizen principles where they apply naturally (not forced): compound interest, enforcement over instructions, specs as hypotheses, etc.

4. **The Horizon** — Where is the system on its L0→L8 journey? What moved? What's the frontier? What's the next wall to hit?

5. **The Gaps** — What's conspicuously absent? What should have happened but didn't? What's the system avoiding?

**Style:** Write like a thoughtful engineering retrospective crossed with a philosophical diary. Concrete (reference PR numbers, specific changes) but reflective (what does it mean?). The reader should feel the momentum AND understand exactly what shipped. Avoid corporate-speak and filler. Be honest about failures and gaps.

## Spirit & Philosophy (read these to understand the voice)

${spirit}`;

  try {
    // Write prompt to temp file to avoid shell quoting issues with special chars.
    // The prompt contains backticks, quotes, newlines — breaks as a CLI arg.
    const tmpDir = mkdtempSync(join(tmpdir(), 'progress-report-'));
    const promptFile = join(tmpDir, 'prompt.txt');
    writeFileSync(promptFile, prompt);

    // Use claude CLI with Sonnet for quality narrative.
    // Auth: subscription token via CLAUDE_CODE_OAUTH_TOKEN (CI) or local OAuth.
    // --dangerously-skip-permissions: non-interactive (CI context)
    // --max-turns 1: single response, no tool use needed
    // Pipe prompt via stdin to avoid arg length limits and quoting issues
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--model',
        'claude-sonnet-4-6',
        '--output-format',
        'text',
        '--max-turns',
        '1',
        '--dangerously-skip-permissions',
      ],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 300_000, // 5 min — large prompt with 100+ PRs needs time
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    rmSync(tmpDir, { recursive: true, force: true });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      console.error(
        `claude CLI exited ${result.status}: ${result.stderr?.slice(0, 200)}`,
      );
      return generateTemplateReport(data);
    }
    const output = result.stdout?.trim();
    if (!output) {
      console.error('Empty claude CLI response');
      return generateTemplateReport(data);
    }
    return output;
  } catch (e: any) {
    console.error(
      `claude CLI failed: ${e.message?.split('\n')[0] || 'unknown error'}`,
    );
    return generateTemplateReport(data);
  }
}

function generateTemplateReport(data: RawData): string {
  const since = getSinceDate();
  const now = new Date().toISOString().slice(0, 10);

  const prLines = data.mergedPRs
    .map(
      (pr) => `| #${pr.number} | ${pr.title} | ${pr.mergedAt.slice(0, 10)} |`,
    )
    .join('\n');

  const breakdown = Object.entries(data.prBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return `# System Progress Report: ${since} → ${now}

## Summary

| Metric | Value |
|--------|-------|
| **PRs merged** | ${data.mergedPRs.length} |
| **Kaizen issues closed** | ${data.closedIssues.length} |
| **Kaizen issues open** | ${data.openIssueCount} |
| **Files changed** | ${data.diffStats.filesChanged} |
| **Lines** | +${data.diffStats.insertions} / -${data.diffStats.deletions} |
| **PR breakdown** | ${breakdown} |

## PRs Merged

| PR | Title | Date |
|----|-------|------|
${prLines}

_This is a template report. Set ANTHROPIC_API_KEY for AI-generated narrative analysis._`;
}

// ── Post to GitHub Discussions ──────────────────────────────────────────

function postDiscussion(title: string, body: string): string {
  const repoId = gh(
    `api graphql -f query='{ repository(owner:"Garsson-io", name:"kaizen") { id } }' --jq '.data.repository.id'`,
  );

  if (!repoId) {
    console.error('Could not get repo ID');
    return '';
  }

  const result = gh(
    `api graphql -f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body}) {
        discussion { url }
      }
    }' -f repoId="${repoId}" -f categoryId="${DISCUSSION_CATEGORY_ID}" -f title=${JSON.stringify(title)} -f body=${JSON.stringify(body)}`,
  );

  try {
    const parsed = JSON.parse(result);
    return parsed.data?.createDiscussion?.discussion?.url || '';
  } catch {
    return '';
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const checkThreshold = args.includes('--check-threshold');
  const dryRun = args.includes('--dry-run');

  const data = gatherData();

  if (checkThreshold) {
    console.log(
      `PRs merged in window: ${data.mergedPRs.length} (threshold: ${PR_THRESHOLD})`,
    );
    process.exit(data.mergedPRs.length >= PR_THRESHOLD ? 0 : 1);
  }

  console.log(
    `${data.mergedPRs.length} PRs, ${data.closedIssues.length} issues closed`,
  );

  const report = await generateNarrative(data);
  const since = getSinceDate();
  const now = new Date().toISOString().slice(0, 10);
  const title = `[Report] ${since} → ${now}: ${data.mergedPRs.length} PRs merged, ${data.closedIssues.length} issues closed`;

  if (dryRun) {
    console.log('\n--- DRY RUN ---\n');
    console.log(`Title: ${title}\n`);
    console.log(report);
    return;
  }

  const url = postDiscussion(title, report);
  if (url) {
    console.log(`Posted: ${url}`);
  } else {
    console.error('Failed to post discussion');
    // Still print the report to stdout for CI logs
    console.log(report);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
