const REPO = "jszynal/longbow";

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  merged_at: string;
  created_at: string;
  updated_at: string;
  state: string;
  draft: boolean;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string | null;
  labels: { name: string; color: string }[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export type PRSize = "XS" | "S" | "M" | "L" | "XL";

export function getPRSize(additions: number, deletions: number): PRSize {
  const total = additions + deletions;
  if (total <= 10) return "XS";
  if (total <= 50) return "S";
  if (total <= 250) return "M";
  if (total <= 1000) return "L";
  return "XL";
}

export function getPRSizeColor(size: PRSize): string {
  const colors: Record<PRSize, string> = {
    XS: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
    S: "text-sky-400 border-sky-400/30 bg-sky-400/10",
    M: "text-amber-400 border-amber-400/30 bg-amber-400/10",
    L: "text-orange-400 border-orange-400/30 bg-orange-400/10",
    XL: "text-red-400 border-red-400/30 bg-red-400/10",
  };
  return colors[size];
}

export interface WeeklyActivity {
  week: string;  // "MMM d" label
  count: number;
  weekStart: string; // ISO date
}

export interface Contributor {
  login: string;
  avatar_url: string;
  count: number;
  additions: number;
  deletions: number;
}

async function fetchToken(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set in environment");
  return token;
}

export async function getLastMergedPRs(count = 3): Promise<PullRequest[]> {
  const token = await fetchToken();
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
    { headers: githubHeaders(token), next: { revalidate: 300 } }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const prs: PullRequest[] = await res.json();
  return prs.filter((pr) => pr.merged_at !== null).slice(0, count);
}

export async function getAllMergedPRs(count = 50): Promise<PullRequest[]> {
  const token = await fetchToken();
  // Fetch enough closed PRs to get `count` merged ones
  const perPage = Math.min(count * 2, 100);
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}`,
    { headers: githubHeaders(token), next: { revalidate: 120 } }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const prs: PullRequest[] = await res.json();
  const merged = prs.filter((pr) => pr.merged_at !== null).slice(0, count);

  // Fetch diff stats for each PR in parallel (batched to avoid rate limits)
  const withStats = await Promise.all(
    merged.map(async (pr) => {
      try {
        const detailRes = await fetch(
          `https://api.github.com/repos/${REPO}/pulls/${pr.number}`,
          { headers: githubHeaders(token), next: { revalidate: 3600 } }
        );
        if (detailRes.ok) {
          const detail = await detailRes.json();
          return { ...pr, additions: detail.additions, deletions: detail.deletions, changed_files: detail.changed_files };
        }
      } catch {}
      return pr;
    })
  );
  return withStats;
}

export async function getOpenPRs(): Promise<PullRequest[]> {
  const token = await fetchToken();
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
    { headers: githubHeaders(token), next: { revalidate: 60 } }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export function computeWeeklyActivity(prs: PullRequest[], weeks = 12): WeeklyActivity[] {
  const now = new Date();
  const result: WeeklyActivity[] = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const count = prs.filter((pr) => {
      if (!pr.merged_at) return false;
      const d = new Date(pr.merged_at);
      return d >= weekStart && d < weekEnd;
    }).length;

    result.push({
      week: weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      weekStart: weekStart.toISOString(),
      count,
    });
  }
  return result;
}

export function computeContributors(prs: PullRequest[]): Contributor[] {
  const map = new Map<string, Contributor>();
  for (const pr of prs) {
    if (!pr.merged_at) continue;
    const existing = map.get(pr.user.login);
    if (existing) {
      existing.count++;
      existing.additions += pr.additions ?? 0;
      existing.deletions += pr.deletions ?? 0;
    } else {
      map.set(pr.user.login, {
        login: pr.user.login,
        avatar_url: pr.user.avatar_url,
        count: 1,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
