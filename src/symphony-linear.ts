import type { ProjectRegistryEntry } from './symphony-routing.js';

const LINEAR_API_URL = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql';
const TEAM_KEY =
  process.env.NANOCLAW_LINEAR_TEAM_KEY || process.env.LINEAR_TEAM_KEY || '';

export type LinearTeamRecord = {
  id: string;
  key: string;
  name: string;
};

export type LinearProjectRecord = {
  id: string;
  name: string;
  url: string;
  state?: string;
};

export type SymphonyLinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  projectName: string;
  labels: string[];
  priority: number;
  priorityLabel: string;
};

export type SymphonyLinearIssueDetail = SymphonyLinearIssueSummary & {
  description: string;
  team: {
    id: string;
    key: string;
    states: Array<{ id: string; name: string; type: string }>;
  };
  recurringIssueTemplate: { id: string; name: string } | null;
};

function requireLinearToken(): string {
  const token = process.env.LINEAR_API_KEY || '';
  if (!token) {
    throw new Error('Missing LINEAR_API_KEY.');
  }
  return token;
}

function requireLinearTeamKey(): string {
  if (!TEAM_KEY) {
    throw new Error('Missing NANOCLAW_LINEAR_TEAM_KEY or LINEAR_TEAM_KEY.');
  }
  return TEAM_KEY;
}

export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      Authorization: requireLinearToken(),
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-symphony-linear',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as { data?: T; errors?: unknown[] };
  if (!response.ok || payload.errors?.length || !payload.data) {
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

function labelNames(labels: { nodes?: Array<{ name: string }> } | null | undefined): string[] {
  return (labels?.nodes || []).map((node) => node.name);
}

export async function listReadyIssuesForProject(
  project: ProjectRegistryEntry,
): Promise<SymphonyLinearIssueSummary[]> {
  const query = TEAM_KEY
    ? `
        query SymphonyReadyIssues($teamKey: String!) {
          issues(
            first: 100
            filter: {
              team: { key: { eq: $teamKey } }
              state: { name: { eq: "Ready" } }
            }
          ) {
            nodes {
              id
              identifier
              title
              url
              priority
              priorityLabel
              state { name }
              project { name }
              labels { nodes { name } }
            }
          }
        }
      `
    : `
        query SymphonyReadyIssues {
          issues(
            first: 100
            filter: {
              state: { name: { eq: "Ready" } }
            }
          ) {
            nodes {
              id
              identifier
              title
              url
              priority
              priorityLabel
              state { name }
              project { name }
              labels { nodes { name } }
            }
          }
        }
      `;

  const data = await linearGraphql<{
    issues: {
      nodes: Array<{
        id: string;
        identifier: string;
        title: string;
        url: string;
        priority?: number | null;
        priorityLabel?: string | null;
        state?: { name?: string } | null;
        project?: { name?: string } | null;
        labels?: { nodes?: Array<{ name: string }> } | null;
      }>;
    };
  }>(query, TEAM_KEY ? { teamKey: TEAM_KEY } : {});

  return data.issues.nodes
    .filter((issue) => (issue.project?.name || '') === project.linearProject)
    .map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name || '',
      projectName: issue.project?.name || '',
      labels: labelNames(issue.labels),
      priority: issue.priority || 0,
      priorityLabel: issue.priorityLabel || '',
    }));
}

export async function getIssueByIdentifier(
  identifier: string,
): Promise<SymphonyLinearIssueDetail> {
  const data = await linearGraphql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      description?: string | null;
      priority?: number | null;
      priorityLabel?: string | null;
      state?: { name?: string | null } | null;
      project?: { name?: string | null } | null;
      labels?: { nodes?: Array<{ name: string }> } | null;
      recurringIssueTemplate?: { id: string; name: string } | null;
      team?: {
        id: string;
        key: string;
        states?: { nodes?: Array<{ id: string; name: string; type: string }> } | null;
      } | null;
    } | null;
  }>(
    `
      query SymphonyIssueByIdentifier($identifier: String!) {
        issue(id: $identifier) {
          id
          identifier
          title
          url
          description
          priority
          priorityLabel
          state { name }
          project { name }
          labels { nodes { name } }
          recurringIssueTemplate { id name }
          team {
            id
            key
            states { nodes { id name type } }
          }
        }
      }
    `,
    { identifier },
  );

  if (!data.issue?.team?.states?.nodes) {
    throw new Error(`Linear issue not found or missing team state metadata: ${identifier}`);
  }

  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    title: data.issue.title,
    url: data.issue.url,
    description: data.issue.description || '',
    state: data.issue.state?.name || '',
    projectName: data.issue.project?.name || '',
    labels: labelNames(data.issue.labels),
    priority: data.issue.priority || 0,
    priorityLabel: data.issue.priorityLabel || '',
    team: {
      id: data.issue.team.id,
      key: data.issue.team.key,
      states: data.issue.team.states.nodes,
    },
    recurringIssueTemplate: data.issue.recurringIssueTemplate ?? null,
  };
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveLinearStateId(
  issue: SymphonyLinearIssueDetail,
  statusName: string,
): string {
  const normalizedTarget = normalizeStatus(statusName);
  const state = issue.team.states.find(
    (candidate) => normalizeStatus(candidate.name) === normalizedTarget,
  );
  if (!state) {
    throw new Error(
      `Linear team ${issue.team.key} is missing state "${statusName}".`,
    );
  }
  return state.id;
}

export async function updateIssueState(issueId: string, stateId: string): Promise<void> {
  await linearGraphql(
    `
      mutation SymphonyIssueUpdate($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `,
    { id: issueId, stateId },
  );
}

export async function addIssueComment(issueId: string, body: string): Promise<void> {
  await linearGraphql(
    `
      mutation SymphonyCommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `,
    { issueId, body },
  );
}

export async function findLinearTeamByKey(teamKey = requireLinearTeamKey()): Promise<LinearTeamRecord> {
  const data = await linearGraphql<{
    teams: {
      nodes: Array<{ id: string; key: string; name: string }>;
    };
  }>(
    `
      query SymphonyTeams {
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
    `,
    {},
  );

  const team = data.teams.nodes.find((candidate) => candidate.key === teamKey);
  if (!team) {
    throw new Error(`Linear team not found for key "${teamKey}".`);
  }

  return team;
}

export async function findLinearProjectByName(
  name: string,
): Promise<LinearProjectRecord | null> {
  const data = await linearGraphql<{
    projects: {
      nodes: Array<{
        id: string;
        name: string;
        url: string;
        state?: string | null;
      }>;
    };
  }>(
    `
      query SymphonyProjectsByName($name: String!) {
        projects(filter: { name: { eq: $name } }) {
          nodes {
            id
            name
            url
            state
          }
        }
      }
    `,
    { name },
  );

  const project = data.projects.nodes[0];
  if (!project) {
    return null;
  }

  return {
    id: project.id,
    name: project.name,
    url: project.url,
    state: project.state || undefined,
  };
}

export async function createLinearProject(input: {
  name: string;
  teamId: string;
}): Promise<LinearProjectRecord> {
  const data = await linearGraphql<{
    projectCreate: {
      success: boolean;
      project: {
        id: string;
        name: string;
        url: string;
        state?: string | null;
      } | null;
    };
  }>(
    `
      mutation SymphonyProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project {
            id
            name
            url
            state
          }
        }
      }
    `,
    {
      input: {
        name: input.name,
        teamIds: [input.teamId],
      },
    },
  );

  if (!data.projectCreate.success || !data.projectCreate.project) {
    throw new Error(`Linear projectCreate did not return a project for "${input.name}".`);
  }

  return {
    id: data.projectCreate.project.id,
    name: data.projectCreate.project.name,
    url: data.projectCreate.project.url,
    state: data.projectCreate.project.state || undefined,
  };
}

export async function ensureLinearProject(
  name: string,
): Promise<{ action: 'linked' | 'created'; project: LinearProjectRecord }> {
  const existing = await findLinearProjectByName(name);
  if (existing) {
    return {
      action: 'linked',
      project: existing,
    };
  }

  const team = await findLinearTeamByKey();
  const created = await createLinearProject({
    name,
    teamId: team.id,
  });

  return {
    action: 'created',
    project: created,
  };
}
