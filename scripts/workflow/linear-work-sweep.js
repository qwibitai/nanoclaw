#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkControlPlane } from './work-control-plane.js';

const LINEAR_API_URL = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql';
const TEAM_KEY =
  process.env.NANOCLAW_LINEAR_TEAM_KEY || process.env.LINEAR_TEAM_KEY || '';
const PROJECT_NAME =
  process.env.NANOCLAW_LINEAR_PROJECT_NAME || process.env.LINEAR_PROJECT_NAME || '';
const PROJECT_ID =
  process.env.NANOCLAW_LINEAR_PROJECT_ID || process.env.LINEAR_PROJECT_ID || '';
const FAIL_EXIT_CODE = 3;
const NIGHTLY_STATE_PATH = path.join(
  process.cwd(),
  '.nanoclaw',
  'nightly-improvement',
  'state.json',
);

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options.set(token.slice(2), 'true');
      continue;
    }
    options.set(token.slice(2), next);
    index += 1;
  }
  return options;
}

function requireLinearToken() {
  const token = process.env.LINEAR_API_KEY || '';
  if (!token) {
    throw new Error('Missing LINEAR_API_KEY for Linear work sweep.');
  }
  return token;
}

async function linearGraphql(query, variables) {
  const token = requireLinearToken();
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-linear-work-sweep',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `Linear GraphQL request failed: ${response.status} ${response.statusText}\n${JSON.stringify(
        payload.errors || payload,
        null,
        2,
      )}`,
    );
  }

  return payload.data;
}

function labelNames(labels) {
  return (labels?.nodes || []).map((node) => node.name);
}

function matchesProject(issue) {
  if (PROJECT_ID && issue.project?.id !== PROJECT_ID) return false;
  if (PROJECT_NAME && issue.project?.name !== PROJECT_NAME) return false;
  return true;
}

function issueRecord(node) {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    priority: node.priorityLabel || `p${node.priority ?? 3}`,
    state: node.state?.name || '',
    stateType: node.state?.type || '',
    labels: labelNames(node.labels),
    projectName: node.project?.name || '',
  };
}

async function fetchIssues() {
  const query = TEAM_KEY
    ? `
        query LinearSweepIssues($teamKey: String!) {
          issues(
            first: 100
            filter: {
              team: { key: { eq: $teamKey } }
              state: { type: { nin: ["completed", "canceled"] } }
            }
          ) {
            nodes {
              id
              identifier
              title
              url
              priority
              priorityLabel
              state {
                name
                type
              }
              project {
                id
                name
              }
              labels {
                nodes {
                  name
                }
              }
            }
          }
        }
      `
    : `
        query LinearSweepIssues {
          issues(
            first: 100
            filter: {
              state: { type: { nin: ["completed", "canceled"] } }
            }
          ) {
            nodes {
              id
              identifier
              title
              url
              priority
              priorityLabel
              state {
                name
                type
              }
              project {
                id
                name
              }
              labels {
                nodes {
                  name
                }
              }
            }
          }
        }
      `;
  const data = await linearGraphql(query, TEAM_KEY ? { teamKey: TEAM_KEY } : {});

  return (data.issues?.nodes || []).map(issueRecord).filter(matchesProject);
}

function formatSection(items, formatter) {
  if (items.length === 0) {
    return '  (none)';
  }
  return items.map(formatter).join('\n');
}

function formatIssueLine(issue) {
  return `  ${issue.identifier}  [${issue.state || '?'}]  ${issue.title}`;
}

function loadNightlyContextRefs() {
  if (!fs.existsSync(NIGHTLY_STATE_PATH)) {
    return [];
  }

  try {
    const state = JSON.parse(fs.readFileSync(NIGHTLY_STATE_PATH, 'utf8'));
    return Object.values(state.context_refs || {}).filter(Boolean);
  } catch {
    return [];
  }
}

function formatNightlyLine(context) {
  const title = context.title || context.kind || 'Nightly context';
  const summary = context.lastDecisionSummary ? `  |  ${context.lastDecisionSummary}` : '';
  const url = context.url ? `  |  ${context.url}` : '';
  return `  ${title}${summary}${url}`;
}

async function main() {
  if (resolveWorkControlPlane() !== 'linear') {
    throw new Error('linear-work-sweep invoked while work control plane is not linear.');
  }

  const options = parseArgs(process.argv.slice(2));
  const agent = options.get('agent') || '';
  const failOnActionItems = options.has('fail-on-action-items');

  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error('Usage: node scripts/workflow/linear-work-sweep.js --agent claude|codex [--fail-on-action-items]');
  }

  const issues = await fetchIssues();
  const agentLabel = `agent:${agent}`;
  const reviewLabel = `review:${agent}`;

  const myIssues = issues.filter((issue) => issue.labels.includes(agentLabel));
  const reviewItems = issues.filter(
    (issue) => issue.labels.includes(reviewLabel) && issue.state.toLowerCase() === 'review',
  );
  const triageItems = issues.filter(
    (issue) => issue.labels.includes(agentLabel) && issue.state.toLowerCase() === 'triage',
  );
  const blockedItems = issues.filter((issue) => issue.state.toLowerCase() === 'blocked');
  const nightlyContexts = loadNightlyContextRefs().filter(
    (context) => String(context.pendingFor || '').toLowerCase() === agent,
  );

  console.log('');
  console.log(`=== Linear Work Sweep (${agent}) ===`);
  if (TEAM_KEY) {
    console.log(`team: ${TEAM_KEY}${PROJECT_NAME ? `  |  project: ${PROJECT_NAME}` : ''}`);
  }
  console.log(`generated: ${new Date().toISOString()}`);
  console.log('');

  console.log('── MY ISSUES ──');
  console.log(formatSection(myIssues, formatIssueLine));
  console.log('');

  console.log('── NEEDS MY REVIEW ──');
  console.log(formatSection(reviewItems, formatIssueLine));
  console.log('');

  console.log('── TRIAGE QUEUE ──');
  console.log(formatSection(triageItems, formatIssueLine));
  console.log('');

  console.log('── BLOCKED ITEMS ──');
  console.log(formatSection(blockedItems, formatIssueLine));
  console.log('');

  console.log('── NIGHTLY CONTEXT HANDOFFS ──');
  console.log(formatSection(nightlyContexts, formatNightlyLine));
  console.log('');

  console.log('=== End Sweep ===');
  console.log('');

  if (failOnActionItems) {
    const reviewCount = reviewItems.length;
    const triageCount = triageItems.length;
    if (reviewCount > 0 || triageCount > 0) {
      const reasons = [];
      if (reviewCount > 0) {
        reasons.push(`REVIEW REQUIRED: ${reviewCount} item(s) in Review.`);
      }
      if (triageCount > 0) {
        reasons.push(`TRIAGE REQUIRED: ${triageCount} item(s) in Triage.`);
      }
      console.error(reasons.join('\n'));
      process.exit(FAIL_EXIT_CODE);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
