#!/usr/bin/env node

import fs from 'node:fs';

const PROJECT_OWNER = process.env.PROJECT_OWNER || 'ingpoc';
const PROJECT_NUMBER = Number.parseInt(process.env.PROJECT_NUMBER || '1', 10);
const PROJECT_URL =
  process.env.PROJECT_URL || `https://github.com/users/${PROJECT_OWNER}/projects/${PROJECT_NUMBER}`;

const LABEL_FIELD_PREFIXES = {
  Agent: 'agent:',
  Lane: 'lane:',
  Priority: 'priority:',
  Risk: 'risk:',
};

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

export function extractIssueNumbers(text) {
  const matches = text?.match(/\B#(\d+)\b/g) || [];
  return Array.from(new Set(matches.map((match) => Number.parseInt(match.slice(1), 10)))).sort(
    (a, b) => a - b,
  );
}

export function deriveIssueStatus({ action, currentStatus, issueState, labels, assigneeCount }) {
  if (issueState === 'CLOSED') return 'Done';
  if (labels.includes('status:blocked')) return 'Blocked';
  if (action === 'opened' || action === 'reopened') return 'Backlog';
  if (action === 'assigned' && assigneeCount > 0) return 'In Progress';
  if (action === 'unassigned' && assigneeCount === 0) return 'Ready';
  if (action === 'unlabeled' && currentStatus === 'Blocked') {
    return assigneeCount > 0 ? 'In Progress' : 'Ready';
  }
  if (!currentStatus) return assigneeCount > 0 ? 'In Progress' : 'Backlog';
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
}) {
  if (issueState === 'CLOSED' || merged) return 'Done';
  if (labels.includes('status:blocked')) return 'Blocked';
  if (pullRequestState === 'OPEN' && !isDraft) return 'Review';
  if (pullRequestState === 'OPEN' && isDraft) return assigneeCount > 0 ? 'In Progress' : 'Ready';
  if (pullRequestState === 'CLOSED') return assigneeCount > 0 ? 'In Progress' : 'Ready';
  return currentStatus || 'Backlog';
}

async function getProject() {
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
    { owner: PROJECT_OWNER, number: PROJECT_NUMBER },
  );

  const project = data.user?.projectV2;
  if (!project) {
    throw new Error(`Project not found: ${PROJECT_URL}`);
  }

  const fields = new Map();
  for (const field of project.fields.nodes || []) {
    if (!field?.name) continue;
    fields.set(field.name, field);
  }
  return { id: project.id, title: project.title, fields };
}

async function getIssue(owner, repo, number, projectId) {
  const data = await githubGraphql(
    `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
            number
            state
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

  const projectItem = (issue.projectItems.nodes || []).find((item) => item.project?.id === projectId) || null;
  return {
    ...issue,
    projectItem,
    fieldValues: itemFieldValueByName(projectItem),
  };
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

async function ensureProjectItem(projectId, issue) {
  if (issue.projectItem?.id) return issue.projectItem.id;
  return addIssueToProject(projectId, issue.id);
}

function optionIdForField(fields, fieldName, optionName) {
  const field = fields.get(fieldName);
  if (!field) return null;
  const option = (field.options || []).find((entry) => entry.name === optionName);
  return option?.id || null;
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
  for (const [fieldName, prefix] of Object.entries(LABEL_FIELD_PREFIXES)) {
    const labelValue = labelValueForPrefix(labels, prefix);
    if (!labelValue) continue;

    const field = project.fields.get(fieldName);
    const optionId = optionIdForField(project.fields, fieldName, labelValue);
    if (!field || !optionId) continue;

    const current = issue.fieldValues.get(fieldName)?.optionId;
    if (current === optionId) continue;
    await setSingleSelectField(project.id, itemId, field.id, optionId);
  }
}

async function ensureDefaultFieldValue(project, issue, itemId, fieldName, optionName) {
  const field = project.fields.get(fieldName);
  if (!field || issue.fieldValues.get(fieldName)?.optionId) return;
  const optionId = optionIdForField(project.fields, fieldName, optionName);
  if (!optionId) return;
  await setSingleSelectField(project.id, itemId, field.id, optionId);
}

async function setStatus(project, issue, itemId, statusName) {
  const field = project.fields.get('Status');
  const optionId = optionIdForField(project.fields, 'Status', statusName);
  if (!field || !optionId) {
    throw new Error(`Project is missing Status field option "${statusName}"`);
  }

  if (issue.fieldValues.get('Status')?.optionId === optionId) return;
  await setSingleSelectField(project.id, itemId, field.id, optionId);
}

async function syncIssue(project, owner, repo, issueNumber, action) {
  const issue = await getIssue(owner, repo, issueNumber, project.id);
  if (!issue) {
    console.log(`No issue found for #${issueNumber}; skipping.`);
    return;
  }

  const itemId = await ensureProjectItem(project.id, issue);
  const labels = labelNames(issue.labels);
  const currentStatus = issue.fieldValues.get('Status')?.value || null;

  await syncLabelBackedFields(project, issue, itemId);
  await ensureDefaultFieldValue(project, issue, itemId, 'Source', 'user');
  await ensureDefaultFieldValue(project, issue, itemId, 'Review Lane', 'none');

  const nextStatus = deriveIssueStatus({
    action,
    currentStatus,
    issueState: issue.state,
    labels,
    assigneeCount: issue.assignees.totalCount,
  });
  await setStatus(project, issue, itemId, nextStatus);

  console.log(`Synced issue #${issue.number} -> ${nextStatus}`);
}

async function syncPullRequest(project, payload) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const body = payload.pull_request.body || '';
  const issueNumbers = extractIssueNumbers(body);

  if (issueNumbers.length === 0) {
    console.log(`PR #${payload.pull_request.number} has no linked issue references; skipping.`);
    return;
  }

  for (const issueNumber of issueNumbers) {
    const issue = await getIssue(owner, repo, issueNumber, project.id);
    if (!issue) continue;

    const itemId = await ensureProjectItem(project.id, issue);
    const labels = labelNames(issue.labels);
    const currentStatus = issue.fieldValues.get('Status')?.value || null;

    await syncLabelBackedFields(project, issue, itemId);
    await ensureDefaultFieldValue(project, issue, itemId, 'Source', 'user');
    await ensureDefaultFieldValue(project, issue, itemId, 'Review Lane', 'none');

    const nextStatus = derivePullRequestStatus({
      issueState: issue.state,
      labels,
      assigneeCount: issue.assignees.totalCount,
      pullRequestState: payload.pull_request.state.toUpperCase(),
      isDraft: Boolean(payload.pull_request.draft),
      merged: Boolean(payload.pull_request.merged_at),
      currentStatus,
    });
    await setStatus(project, issue, itemId, nextStatus);
    console.log(`Synced linked issue #${issue.number} from PR #${payload.pull_request.number} -> ${nextStatus}`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !['intake', 'status'].includes(mode)) {
    throw new Error('Usage: node scripts/workflow/github-project-sync.js <intake|status>');
  }

  const payload = loadEventPayload();
  const project = await getProject();

  if (mode === 'intake') {
    if (!payload.issue) {
      console.log('No issue payload found for intake mode; nothing to do.');
      return;
    }
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    await syncIssue(project, owner, repo, payload.issue.number, payload.action);
    return;
  }

  if (payload.issue) {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    await syncIssue(project, owner, repo, payload.issue.number, payload.action);
    return;
  }

  if (payload.pull_request) {
    await syncPullRequest(project, payload);
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
