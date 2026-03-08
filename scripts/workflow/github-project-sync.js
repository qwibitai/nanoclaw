#!/usr/bin/env node

import fs from 'node:fs';

// Repo/issues/discussions live on ingpoc/nanoclaw. The NanoClaw platform board
// is owned by ingpoc, while the Andy/Jarvis delivery board is owned by
// openclaw-gurusharan.
const LEGACY_PROJECT_OWNER = process.env.PROJECT_OWNER || 'ingpoc';
const LEGACY_PROJECT_NUMBER = Number.parseInt(process.env.PROJECT_NUMBER || '1', 10);
const LEGACY_PROJECT_URL =
  process.env.PROJECT_URL ||
  `https://github.com/users/${LEGACY_PROJECT_OWNER}/projects/${LEGACY_PROJECT_NUMBER}`;

const BOARD_CONFIGS = [
  {
    key: 'platform',
    owner:
      process.env.PLATFORM_PROJECT_OWNER ||
      process.env.PROJECT_OWNER ||
      'ingpoc',
    name: process.env.PLATFORM_PROJECT_NAME || 'NanoClaw Platform',
    number: Number.parseInt(process.env.PLATFORM_PROJECT_NUMBER || String(LEGACY_PROJECT_NUMBER), 10),
    url:
      process.env.PLATFORM_PROJECT_URL ||
      process.env.PROJECT_URL ||
      `https://github.com/users/${
        process.env.PLATFORM_PROJECT_OWNER || process.env.PROJECT_OWNER || 'ingpoc'
      }/projects/${process.env.PLATFORM_PROJECT_NUMBER || String(LEGACY_PROJECT_NUMBER)}`,
  },
  ...(process.env.DELIVERY_PROJECT_NUMBER
    ? [
        {
          key: 'delivery',
          owner:
            process.env.DELIVERY_PROJECT_OWNER ||
            process.env.PROJECT_OWNER ||
            'openclaw-gurusharan',
          name: process.env.DELIVERY_PROJECT_NAME || 'Andy/Jarvis Delivery',
          number: Number.parseInt(process.env.DELIVERY_PROJECT_NUMBER, 10),
          url:
            process.env.DELIVERY_PROJECT_URL ||
            `https://github.com/users/${
              process.env.DELIVERY_PROJECT_OWNER ||
              process.env.PROJECT_OWNER ||
              'openclaw-gurusharan'
            }/projects/${process.env.DELIVERY_PROJECT_NUMBER}`,
        },
      ]
    : []),
].filter((config, index, all) => Number.isFinite(config.number) && all.findIndex((entry) => entry.number === config.number) === index);

const LABEL_FIELD_PREFIXES = {
  Agent: 'agent:',
  Worker: 'agent:',
  Lane: 'lane:',
  Priority: 'priority:',
  Risk: 'risk:',
};

const STATUS_FIELD_NAMES = ['Workflow Status', 'Status'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadEventPayload() {
  const eventPath = requireEnv('GITHUB_EVENT_PATH');
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

async function githubGraphql(query, variables) {
  const token = requireEnv('GITHUB_TOKEN');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-project-sync',
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

function labelNames(labelConnection) {
  return (labelConnection?.nodes || []).map((node) => node.name);
}

function itemFieldValueByName(projectItem) {
  const values = new Map();
  for (const node of projectItem?.fieldValues?.nodes || []) {
    if (!node?.field?.name) continue;
    values.set(node.field.name, {
      optionId: node.optionId,
      value: node.name,
    });
  }
  return values;
}

function labelValueForPrefix(labels, prefix) {
  const match = labels.find((label) => label.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function normalizeBoardName(value) {
  return value?.trim().toLowerCase().replace(/\s+/g, ' ') || null;
}

function extractFieldValue(text, label) {
  const patterns = [
    new RegExp(`^###\\s+${label}\\s*\\n+([^\\n]+)`, 'im'),
    new RegExp(`^${label}:\\s*([^\\n]+)`, 'im'),
  ];

  for (const pattern of patterns) {
    const match = text?.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function extractExecutionBoard(body) {
  return (
    extractFieldValue(body, 'Execution Board') ||
    extractFieldValue(body, 'Board Target') ||
    extractFieldValue(body, 'Execution Surface')
  );
}

export function resolveBoardKey(boardValue) {
  const normalized = normalizeBoardName(boardValue);
  if (!normalized) return 'platform';
  if (normalized.includes('andy/jarvis delivery')) return 'delivery';
  if (normalized.includes('delivery')) return 'delivery';
  if (normalized.includes('nanoclaw platform')) return 'platform';
  if (normalized.includes('platform')) return 'platform';
  return 'platform';
}

export function extractIssueNumbers(text) {
  const matches = text?.match(/\B#(\d+)\b/g) || [];
  return Array.from(new Set(matches.map((match) => Number.parseInt(match.slice(1), 10)))).sort(
    (a, b) => a - b,
  );
}

export function deriveIssueStatus({ action, currentStatus, issueState, labels, assigneeCount, boardKey }) {
  if (boardKey === 'delivery') {
    if (issueState === 'CLOSED') return 'Done';
    if (labels.includes('status:blocked')) return 'Blocked';
    if (action === 'opened' || action === 'reopened') return 'Backlog';
    if (action === 'unlabeled' && currentStatus === 'Blocked') {
      return 'Backlog';
    }
    return currentStatus || 'Backlog';
  }

  if (issueState === 'CLOSED') return 'Done';
  if (labels.includes('status:blocked')) return 'Blocked';
  if (action === 'opened' || action === 'reopened') return 'Backlog';
  if (action === 'unlabeled' && currentStatus === 'Blocked') {
    return 'Backlog';
  }
  if (!currentStatus) return 'Backlog';
  return currentStatus;
}

export function derivePullRequestStatus({
  issueState,
  labels,
  assigneeCount,
  pullRequestState,
  isDraft,
  merged,
  currentStatus,
  boardKey,
}) {
  if (boardKey === 'delivery') {
    if (issueState === 'CLOSED' || merged) return 'Done';
    if (labels.includes('status:blocked')) return 'Blocked';
    if (pullRequestState === 'OPEN' && !isDraft) return 'Review';
    if (pullRequestState === 'OPEN' && isDraft) return currentStatus || 'In Progress';
    return currentStatus || 'Backlog';
  }

  if (issueState === 'CLOSED' || merged) return 'Done';
  if (labels.includes('status:blocked')) return 'Blocked';
  if (pullRequestState === 'OPEN' && !isDraft) return 'Review';
  if (pullRequestState === 'OPEN' && isDraft) return currentStatus || 'In Progress';
  if (pullRequestState === 'CLOSED') return currentStatus || 'Backlog';
  return currentStatus || 'Backlog';
}

async function getProjects() {
  const projects = [];
  for (const config of BOARD_CONFIGS) {
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
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner: config.owner, number: config.number },
    );

    const project = data.user?.projectV2;
    if (!project) {
      throw new Error(`Project not found: ${config.url}`);
    }

    const fields = new Map();
    for (const field of project.fields.nodes || []) {
      if (!field?.name) continue;
      fields.set(field.name, field);
    }

    projects.push({
      ...config,
      id: project.id,
      title: project.title,
      fields,
    });
  }
  return projects;
}

async function getIssue(owner, repo, number, projectIds) {
  const data = await githubGraphql(
    `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
            number
            state
            body
            labels(first: 50) {
              nodes {
                name
              }
            }
            assignees(first: 20) {
              totalCount
            }
            projectItems(first: 20) {
              nodes {
                id
                project {
                  id
                }
                fieldValues(first: 50) {
                  nodes {
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
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner, repo, number },
  );

  const issue = data.repository?.issue;
  if (!issue) return null;

  const projectItems = (issue.projectItems.nodes || [])
    .filter((item) => projectIds.has(item.project?.id))
    .map((item) => ({
      ...item,
      fieldValues: itemFieldValueByName(item),
    }));

  return {
    ...issue,
    projectItems,
  };
}

function resolveProjectForIssue(projects, issue) {
  const existingItem = issue.projectItems[0];
  if (existingItem) {
    const existingProject = projects.find((project) => project.id === existingItem.project?.id);
    if (existingProject) return existingProject;
  }

  const boardKey = resolveBoardKey(extractExecutionBoard(issue.body));
  const matchedProject = projects.find((project) => project.key === boardKey);
  return matchedProject || projects[0];
}

function projectItemForProject(issue, projectId) {
  return issue.projectItems.find((item) => item.project?.id === projectId) || null;
}

async function addIssueToProject(projectId, issueId) {
  const data = await githubGraphql(
    `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `,
    { projectId, contentId: issueId },
  );

  return data.addProjectV2ItemById.item.id;
}

async function ensureProjectItem(project, issue) {
  const existing = projectItemForProject(issue, project.id);
  if (existing?.id) return existing.id;
  const itemId = await addIssueToProject(project.id, issue.id);
  issue.projectItems.push({
    id: itemId,
    project: { id: project.id },
    fieldValues: new Map(),
  });
  return itemId;
}

function optionIdForField(fields, fieldName, optionName) {
  const field = fields.get(fieldName);
  if (!field) return null;
  const option = (field.options || []).find((entry) => entry.name === optionName);
  return option?.id || null;
}

function getStatusFieldName(project) {
  return STATUS_FIELD_NAMES.find((fieldName) => project.fields.has(fieldName)) || null;
}

function resolveStatusOption(project, fieldName, statusName) {
  const direct = optionIdForField(project.fields, fieldName, statusName);
  if (direct) return direct;

  if (fieldName === 'Status') {
    const fallbackMap = {
      Backlog: 'Todo',
      Ready: 'Todo',
      Blocked: 'Todo',
      Review: 'In Progress',
      'In Progress': 'In Progress',
      Done: 'Done',
    };
    const fallback = fallbackMap[statusName];
    if (fallback) {
      return optionIdForField(project.fields, fieldName, fallback);
    }
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

async function syncLabelBackedFields(project, issue, itemId) {
  const labels = labelNames(issue.labels);
  const projectItem = projectItemForProject(issue, project.id);
  const currentFieldValues = projectItem?.fieldValues || new Map();

  for (const [fieldName, prefix] of Object.entries(LABEL_FIELD_PREFIXES)) {
    const labelValue = labelValueForPrefix(labels, prefix);
    if (!labelValue) continue;

    const field = project.fields.get(fieldName);
    const optionId = optionIdForField(project.fields, fieldName, labelValue);
    if (!field || !optionId) continue;

    const current = currentFieldValues.get(fieldName)?.optionId;
    if (current === optionId) continue;
    await setSingleSelectField(project.id, itemId, field.id, optionId);
  }
}

async function ensureDefaultFieldValue(project, issue, itemId, fieldName, optionName) {
  const field = project.fields.get(fieldName);
  const projectItem = projectItemForProject(issue, project.id);
  if (!field || projectItem?.fieldValues?.get(fieldName)?.optionId) return;
  const optionId = optionIdForField(project.fields, fieldName, optionName);
  if (!optionId) return;
  await setSingleSelectField(project.id, itemId, field.id, optionId);
}

async function setStatus(project, issue, itemId, statusName) {
  const fieldName = getStatusFieldName(project);
  if (!fieldName) {
    throw new Error(`Project ${project.title} is missing a status field`);
  }

  const field = project.fields.get(fieldName);
  const optionId = resolveStatusOption(project, fieldName, statusName);
  if (!field || !optionId) {
    throw new Error(`Project ${project.title} is missing ${fieldName} field option "${statusName}"`);
  }

  const projectItem = projectItemForProject(issue, project.id);
  if (projectItem?.fieldValues?.get(fieldName)?.optionId === optionId) return;
  await setSingleSelectField(project.id, itemId, field.id, optionId);
}

async function syncIssue(projects, owner, repo, issueNumber, action) {
  const issue = await getIssue(owner, repo, issueNumber, new Set(projects.map((project) => project.id)));
  if (!issue) {
    console.log(`No issue found for #${issueNumber}; skipping.`);
    return;
  }

  const project = resolveProjectForIssue(projects, issue);
  const itemId = await ensureProjectItem(project, issue);
  const labels = labelNames(issue.labels);
  const boardKey = project.key;
  const statusFieldName = getStatusFieldName(project);
  const currentStatus =
    (statusFieldName
      ? projectItemForProject(issue, project.id)?.fieldValues?.get(statusFieldName)?.value
      : null) || null;

  await syncLabelBackedFields(project, issue, itemId);
  await ensureDefaultFieldValue(project, issue, itemId, 'Source', 'user');
  await ensureDefaultFieldValue(project, issue, itemId, 'Review Lane', 'none');
  await ensureDefaultFieldValue(project, issue, itemId, 'Worker', 'none');
  if (boardKey === 'delivery') {
    await ensureDefaultFieldValue(project, issue, itemId, 'Agent', 'andy-developer');
  }

  const nextStatus = deriveIssueStatus({
    action,
    currentStatus,
    issueState: issue.state,
    labels,
    assigneeCount: issue.assignees.totalCount,
    boardKey,
  });
  await setStatus(project, issue, itemId, nextStatus);

  console.log(`Synced issue #${issue.number} on ${project.title} -> ${nextStatus}`);
}

async function syncPullRequest(projects, payload) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const body = payload.pull_request.body || '';
  const issueNumbers = extractIssueNumbers(body);

  if (issueNumbers.length === 0) {
    console.log(`PR #${payload.pull_request.number} has no linked issue references; skipping.`);
    return;
  }

  const projectIds = new Set(projects.map((project) => project.id));

  for (const issueNumber of issueNumbers) {
    const issue = await getIssue(owner, repo, issueNumber, projectIds);
    if (!issue) continue;

    const project = resolveProjectForIssue(projects, issue);
    const itemId = await ensureProjectItem(project, issue);
    const labels = labelNames(issue.labels);
    const boardKey = project.key;
    const statusFieldName = getStatusFieldName(project);
    const currentStatus =
      (statusFieldName
        ? projectItemForProject(issue, project.id)?.fieldValues?.get(statusFieldName)?.value
        : null) || null;

    await syncLabelBackedFields(project, issue, itemId);
    await ensureDefaultFieldValue(project, issue, itemId, 'Source', 'user');
    await ensureDefaultFieldValue(project, issue, itemId, 'Review Lane', 'none');
    await ensureDefaultFieldValue(project, issue, itemId, 'Worker', 'none');
    if (boardKey === 'delivery') {
      await ensureDefaultFieldValue(project, issue, itemId, 'Agent', 'andy-developer');
    }

    const nextStatus = derivePullRequestStatus({
      issueState: issue.state,
      labels,
      assigneeCount: issue.assignees.totalCount,
      pullRequestState: payload.pull_request.state.toUpperCase(),
      isDraft: Boolean(payload.pull_request.draft),
      merged: Boolean(payload.pull_request.merged_at),
      currentStatus,
      boardKey,
    });
    await setStatus(project, issue, itemId, nextStatus);
    console.log(`Synced linked issue #${issue.number} on ${project.title} from PR #${payload.pull_request.number} -> ${nextStatus}`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !['intake', 'status'].includes(mode)) {
    throw new Error('Usage: node scripts/workflow/github-project-sync.js <intake|status>');
  }

  const payload = loadEventPayload();
  const projects = await getProjects();

  if (mode === 'intake') {
    if (!payload.issue) {
      console.log('No issue payload found for intake mode; nothing to do.');
      return;
    }
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    await syncIssue(projects, owner, repo, payload.issue.number, payload.action);
    return;
  }

  if (payload.issue) {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    await syncIssue(projects, owner, repo, payload.issue.number, payload.action);
    return;
  }

  if (payload.pull_request) {
    await syncPullRequest(projects, payload);
    return;
  }

  console.log(`Unsupported event payload for mode ${mode}; nothing to do.`);
}

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
