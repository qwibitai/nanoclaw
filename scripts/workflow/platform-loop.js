#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_OWNER =
  process.env.PROJECT_OWNER ||
  process.env.NANOCLAW_PLATFORM_PROJECT_OWNER ||
  'ingpoc';
const PLATFORM_PROJECT_NUMBER = Number.parseInt(
  process.env.PLATFORM_PROJECT_NUMBER ||
    process.env.NANOCLAW_PLATFORM_PROJECT_NUMBER ||
    '1',
  10,
);
const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'ingpoc';
const REPO_NAME =
  process.env.GITHUB_REPOSITORY?.split('/')[1] ||
  process.env.NANOCLAW_PLATFORM_REPO_NAME ||
  'nanoclaw';

const PLATFORM_STATUS_FIELD_NAMES = ['Workflow Status', 'Status'];
const PLATFORM_STATUS_GROUPS = {
  ready: ['Ready', 'Ready for Dispatch'],
  running: ['In Progress', 'Claude Running'],
  review: ['Review', 'Review Queue'],
  blocked: ['Blocked'],
  done: ['Done'],
  backlog: ['Backlog', 'Triage'],
};
const PLATFORM_REQUIRED_SECTIONS = [
  'Problem Statement',
  'Scope',
  'Acceptance Criteria',
  'Expected Productivity Gain',
  'Required Checks',
  'Required Evidence',
  'Blocked If',
];
const PRIORITY_ORDER = ['p0', 'p1', 'p2'];
const AUTONOMY_SOURCE_ROOT =
  process.env.NANOCLAW_AUTONOMY_SOURCE_ROOT || process.cwd();
const AUTONOMY_PAUSE_FILE = path.join(
  AUTONOMY_SOURCE_ROOT,
  '.nanoclaw',
  'autonomy',
  'pause.json',
);

function requireCommand(name) {
  const value = process.argv[2];
  if (!value) {
    throw new Error(`Usage: node scripts/workflow/platform-loop.js <${name}>`);
  }
  return value;
}

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

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work';
}

export function buildPlatformBranchName(issueNumber, title) {
  return `claude-platform-${issueNumber}-${slugify(title)}`;
}

function formatTimestamp(now) {
  const iso = now.toISOString().replace(/[-:]/g, '');
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

export function buildPlatformRunContext(issueNumber, title, now = new Date()) {
  const stamp = formatTimestamp(now);
  return {
    requestId: `platform-issue-${issueNumber}-${stamp.toLowerCase()}`,
    runId: `claude-platform-${issueNumber}-${stamp.toLowerCase()}`,
    branch: buildPlatformBranchName(issueNumber, title),
  };
}

function sectionPattern(sectionName) {
  return new RegExp(`^##+\\s+${sectionName}\\s*$`, 'im');
}

export function missingPlatformSections(body) {
  return PLATFORM_REQUIRED_SECTIONS.filter(
    (sectionName) => !sectionPattern(sectionName).test(body || ''),
  );
}

function labelNames(labelConnection) {
  return (labelConnection?.nodes || []).map((node) => node.name);
}

function resolveToken() {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.ADD_TO_PROJECT_PAT ||
    process.env.GH_TOKEN ||
    '';

  if (token) return token;

  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function hasExplicitGithubToken() {
  return Boolean(
    process.env.GITHUB_TOKEN || process.env.ADD_TO_PROJECT_PAT || process.env.GH_TOKEN,
  );
}

function activeGhUser() {
  try {
    return execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function ensureExpectedGhUser(expectedUser) {
  if (hasExplicitGithubToken()) return;
  const activeUser = activeGhUser();
  if (!activeUser) {
    throw new Error(`Unable to determine active gh account; expected ${expectedUser}`);
  }
  if (activeUser !== expectedUser) {
    throw new Error(`Active gh account must be ${expectedUser}; found ${activeUser}`);
  }
}

async function githubGraphql(query, variables) {
  ensureExpectedGhUser(PROJECT_OWNER);
  const token = resolveToken();
  if (!token) {
    throw new Error(
      'Missing GitHub token. Set GITHUB_TOKEN, ADD_TO_PROJECT_PAT, or authenticate gh.',
    );
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-platform-loop',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL request failed: ${response.status} ${
        response.statusText
      }\n${JSON.stringify(payload.errors || payload, null, 2)}`,
    );
  }
  return payload.data;
}

function fieldValueByName(fieldValues) {
  const values = new Map();
  for (const node of fieldValues?.nodes || []) {
    const fieldName = node?.field?.name;
    if (!fieldName) continue;

    if (node.__typename === 'ProjectV2ItemFieldSingleSelectValue') {
      values.set(fieldName, {
        type: 'single_select',
        optionId: node.optionId,
        value: node.name,
      });
      continue;
    }

    if (node.__typename === 'ProjectV2ItemFieldTextValue') {
      values.set(fieldName, {
        type: 'text',
        value: node.text || '',
      });
    }
  }
  return values;
}

function priorityRank(priorityValue) {
  const normalized = String(priorityValue || '').toLowerCase();
  const index = PRIORITY_ORDER.indexOf(normalized);
  return index === -1 ? PRIORITY_ORDER.length : index;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function statusMatches(value, groupName) {
  const group = PLATFORM_STATUS_GROUPS[groupName] || [];
  const normalized = normalizeStatus(value);
  return group.some((candidate) => normalizeStatus(candidate) === normalized);
}

function statusCandidates(value) {
  const normalized = normalizeStatus(value);
  for (const group of Object.values(PLATFORM_STATUS_GROUPS)) {
    if (group.some((candidate) => normalizeStatus(candidate) === normalized)) {
      return group;
    }
  }
  return [value];
}

function getStatusValue(fieldValues) {
  for (const fieldName of PLATFORM_STATUS_FIELD_NAMES) {
    const value = fieldValues.get(fieldName)?.value;
    if (value) return value;
  }
  return null;
}

function summarizeNoop(reason, details = {}) {
  return {
    action: 'noop',
    reason,
    ...details,
  };
}

export function selectPlatformCandidate(items) {
  if (fs.existsSync(AUTONOMY_PAUSE_FILE)) {
    try {
      const pauseState = JSON.parse(
        fs.readFileSync(AUTONOMY_PAUSE_FILE, 'utf8'),
      );
      if (pauseState?.paused) {
        return summarizeNoop('pause_active', {
          pauseReason: pauseState.reason || '',
          pauseSource: pauseState.source || '',
        });
      }
    } catch {
      return summarizeNoop('pause_state_invalid');
    }
  }

  const reviewQueueItems = items.filter(
    (item) => item.agent === 'claude' && statusMatches(item.status, 'review'),
  );
  if (reviewQueueItems.length > 0) {
    return summarizeNoop('review_queue_present', {
      blockingIssueNumbers: reviewQueueItems.map((item) => item.number),
    });
  }

  const runningItems = items.filter(
    (item) => item.agent === 'claude' && statusMatches(item.status, 'running'),
  );
  if (runningItems.length > 0) {
    return summarizeNoop('claude_running_present', {
      blockingIssueNumbers: runningItems.map((item) => item.number),
    });
  }

  const eligible = items
    .filter((item) => item.state === 'OPEN')
    .filter((item) => statusMatches(item.status, 'ready'))
    .filter((item) => !item.agent || item.agent === 'claude')
    .filter((item) => !item.labels.includes('status:blocked'))
    .filter((item) => !item.labels.includes('autonomy-blocked'))
    .filter((item) => item.missingSections.length === 0)
    .sort((left, right) => {
      const priorityDelta =
        priorityRank(left.priority) - priorityRank(right.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return left.number - right.number;
    });

  if (eligible.length === 0) {
    return summarizeNoop('no_eligible_issue', {
      candidatesChecked: items.map((item) => ({
        number: item.number,
        status: item.status,
        priority: item.priority,
        blocked:
          item.labels.includes('status:blocked') ||
          item.labels.includes('autonomy-blocked'),
        missingSections: item.missingSections,
      })),
    });
  }

  const selected = eligible[0];
  return {
    action: 'pickup',
    issue: {
      number: selected.number,
      title: selected.title,
      url: selected.url,
      status: selected.status,
      agent: selected.agent,
      priority: selected.priority,
      labels: selected.labels,
      missingSections: selected.missingSections,
      requestId: selected.requestId,
      runId: selected.runId,
      nextDecision: selected.nextDecision,
      branch: buildPlatformBranchName(selected.number, selected.title),
    },
  };
}

async function getPlatformProject() {
  const data = await githubGraphql(
    `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            title
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
                  options {
                    id
                    name
                  }
                }
              }
            }
            items(first: 100) {
              nodes {
                id
                fieldValues(first: 50) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      optionId
                      field {
                        ... on ProjectV2SingleSelectField {
                          id
                          name
                        }
                      }
                    }
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field {
                        ... on ProjectV2FieldCommon {
                          id
                          name
                        }
                      }
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    title
                    url
                    body
                    state
                    labels(first: 50) {
                      nodes {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner: PROJECT_OWNER, number: PLATFORM_PROJECT_NUMBER },
  );

  const project = data.user?.projectV2;
  if (!project) {
    throw new Error(
      `Platform project not found: ${PROJECT_OWNER} #${PLATFORM_PROJECT_NUMBER}`,
    );
  }

  const fields = new Map();
  for (const field of project.fields.nodes || []) {
    if (!field?.name) continue;
    fields.set(field.name, field);
  }

  const items = (project.items.nodes || [])
    .filter((item) => item?.content?.__typename === 'Issue')
    .map((item) => {
      const issue = item.content;
      const labels = labelNames(issue.labels);
      const fieldValues = fieldValueByName(item.fieldValues);
      return {
        projectItemId: item.id,
        issueId: issue.id,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body || '',
        state: issue.state,
        labels,
        fieldValues,
        status: getStatusValue(fieldValues),
        agent: fieldValues.get('Agent')?.value || '',
        priority: fieldValues.get('Priority')?.value || 'p2',
        requestId: fieldValues.get('Request ID')?.value || '',
        runId: fieldValues.get('Run ID')?.value || '',
        nextDecision: fieldValues.get('Next Decision')?.value || '',
        missingSections: missingPlatformSections(issue.body || ''),
      };
    });

  return {
    id: project.id,
    title: project.title,
    fields,
    items,
  };
}

async function getPlatformIssue(project, issueNumber) {
  const issue = project.items.find((item) => item.number === issueNumber);
  if (!issue) {
    throw new Error(`Issue #${issueNumber} is not on ${project.title}`);
  }
  return issue;
}

function fieldOptionId(project, fieldName, optionName) {
  const field = project.fields.get(fieldName);
  if (!field?.options) return null;
  const option = field.options.find((entry) => entry.name === optionName);
  return option?.id || null;
}

function resolveStatusOptionId(project, fieldName, desiredStatus) {
  const field = project.fields.get(fieldName);
  if (!field?.options) return null;
  for (const candidate of statusCandidates(desiredStatus)) {
    const option = field.options.find((entry) => entry.name === candidate);
    if (option) return option.id;
  }
  return null;
}

async function setSingleSelectField(projectId, itemId, fieldId, optionId) {
  await githubGraphql(
    `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    { projectId, itemId, fieldId, optionId },
  );
}

async function setTextField(projectId, itemId, fieldId, text) {
  await githubGraphql(
    `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { text: $text }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    { projectId, itemId, fieldId, text },
  );
}

async function handleNext() {
  const project = await getPlatformProject();
  const selection = selectPlatformCandidate(project.items);
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
}

async function handleIds(options) {
  const issueNumber = Number.parseInt(options.get('issue') || '', 10);
  const title = options.get('title') || `issue-${issueNumber}`;
  if (!Number.isFinite(issueNumber)) {
    throw new Error('--issue is required for ids');
  }
  process.stdout.write(
    `${JSON.stringify(buildPlatformRunContext(issueNumber, title), null, 2)}\n`,
  );
}

async function handleSetStatus(options) {
  const issueNumber = Number.parseInt(options.get('issue') || '', 10);
  const status = options.get('status') || '';
  if (!Number.isFinite(issueNumber) || !status) {
    throw new Error('--issue and --status are required for set-status');
  }

  const project = await getPlatformProject();
  const issue = await getPlatformIssue(project, issueNumber);

  const statusFieldName =
    PLATFORM_STATUS_FIELD_NAMES.find((fieldName) =>
      project.fields.has(fieldName),
    ) || null;
  if (!statusFieldName) {
    throw new Error(`Project ${project.title} is missing a status field`);
  }

  const updates = [
    {
      fieldName: statusFieldName,
      type: 'single_select',
      value: status,
    },
  ];

  for (const pair of [
    ['agent', 'Agent', 'single_select'],
    ['review-lane', 'Review Lane', 'single_select'],
    ['request-id', 'Request ID', 'text'],
    ['run-id', 'Run ID', 'text'],
    ['next-decision', 'Next Decision', 'text'],
  ]) {
    const [argName, fieldName, type] = pair;
    if (!options.has(argName)) continue;
    updates.push({
      fieldName,
      type,
      value: options.get(argName) || '',
    });
  }

  for (const update of updates) {
    const field = project.fields.get(update.fieldName);
    if (!field) {
      if (update.fieldName === statusFieldName) {
        throw new Error(
          `Project ${project.title} is missing required field ${update.fieldName}`,
        );
      }
      continue;
    }

    if (update.type === 'single_select') {
      const optionId =
        update.fieldName === statusFieldName
          ? resolveStatusOptionId(project, update.fieldName, update.value)
          : fieldOptionId(project, update.fieldName, update.value);
      if (!optionId) {
        throw new Error(
          `Project ${project.title} is missing option "${update.value}" for ${update.fieldName}`,
        );
      }
      await setSingleSelectField(project.id, issue.projectItemId, field.id, optionId);
      continue;
    }

    await setTextField(project.id, issue.projectItemId, field.id, update.value);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        issue: issueNumber,
        status,
        updatedFields: updates.map((update) => update.fieldName),
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const command = requireCommand('next|ids|set-status');
  const options = parseArgs(process.argv.slice(3));

  if (command === 'next') {
    await handleNext();
    return;
  }

  if (command === 'ids') {
    await handleIds(options);
    return;
  }

  if (command === 'set-status') {
    await handleSetStatus(options);
    return;
  }

  throw new Error(
    `Unknown command "${command}". Use next, ids, or set-status.`,
  );
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
