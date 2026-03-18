// GitHub API layer — abstracts GitHub API calls for testability.

export interface GitHubIssue {
  number: number;
  title: string;
  labels: string[];
  state: string;
  created_at: string;
  assignee: string | null;
  html_url: string;
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface ListIssuesParams {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  labels?: string;
}

export type GitHubClient = {
  listIssues: (params: ListIssuesParams) => Promise<GitHubIssue[]>;
  createIssue: (params: CreateIssueParams) => Promise<GitHubIssue>;
};

/**
 * Create a real GitHub API client using the provided token.
 */
export function createGitHubClient(token: string): GitHubClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'X-ServiceBot',
  };

  return {
    async listIssues(params: ListIssuesParams): Promise<GitHubIssue[]> {
      const url = new URL(
        `https://api.github.com/repos/${params.owner}/${params.repo}/issues`,
      );
      if (params.state) url.searchParams.set('state', params.state);
      if (params.labels) url.searchParams.set('labels', params.labels);

      const res = await fetch(url.toString(), { headers });

      if (res.status === 401) {
        throw new Error('GitHub authentication failed. Check GITHUB_TOKEN.');
      }
      if (res.status === 403) {
        const rateLimitReset = res.headers.get('x-ratelimit-reset');
        const retryAfter = rateLimitReset
          ? new Date(parseInt(rateLimitReset) * 1000).toISOString()
          : 'unknown';
        throw new Error(`GitHub rate limit exceeded. Resets at: ${retryAfter}`);
      }
      if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as any[];
      return data.map((issue) => ({
        number: issue.number,
        title: issue.title,
        labels: issue.labels.map((l: any) => l.name),
        state: issue.state,
        created_at: issue.created_at,
        assignee: issue.assignee?.login ?? null,
        html_url: issue.html_url,
      }));
    },

    async createIssue(params: CreateIssueParams): Promise<GitHubIssue> {
      const url = `https://api.github.com/repos/${params.owner}/${params.repo}/issues`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: params.title,
          body: params.body,
          labels: params.labels ?? [],
        }),
      });

      if (res.status === 401) {
        throw new Error('GitHub authentication failed. Check GITHUB_TOKEN.');
      }
      if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
      }

      const issue = (await res.json()) as any;
      return {
        number: issue.number,
        title: issue.title,
        labels: issue.labels.map((l: any) => l.name),
        state: issue.state,
        created_at: issue.created_at,
        assignee: issue.assignee?.login ?? null,
        html_url: issue.html_url,
      };
    },
  };
}
