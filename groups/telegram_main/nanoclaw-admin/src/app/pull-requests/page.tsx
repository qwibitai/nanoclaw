import { Suspense } from "react";
import { GitMerge, GitPullRequest, RefreshCw, Users, TrendingUp } from "lucide-react";
import { getAllMergedPRs, getOpenPRs, computeWeeklyActivity, computeContributors } from "@/lib/github";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRFeed } from "@/components/pull-requests/PRFeed";
import { MergeActivityChart } from "@/components/pull-requests/MergeActivityChart";
import { OpenPRsSection } from "@/components/pull-requests/OpenPRsSection";
import { ContributorLeaderboard } from "@/components/pull-requests/ContributorLeaderboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function PullRequestsContent() {
  const [mergedResult, openResult] = await Promise.allSettled([
    getAllMergedPRs(50),
    getOpenPRs(),
  ]);

  const mergedPRs = mergedResult.status === "fulfilled" ? mergedResult.value : [];
  const openPRs = openResult.status === "fulfilled" ? openResult.value : [];
  const mergeError = mergedResult.status === "rejected" ? String(mergedResult.reason) : null;

  const weeklyActivity = computeWeeklyActivity(mergedPRs, 12);
  const contributors = computeContributors(mergedPRs);
  const totalMergedThisMonth = mergedPRs.filter((pr) => {
    const d = new Date(pr.merged_at);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <GitMerge className="h-5 w-5 text-violet-400" />
            Pull Requests
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            <a
              href="https://github.com/jszynal/longbow"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              jszynal/longbow
            </a>
          </p>
        </div>
        <form action="/pull-requests" method="GET">
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </form>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Open PRs</p>
          <p className={`text-2xl font-bold mt-0.5 ${openPRs.length > 0 ? "text-amber-400" : "text-emerald-400"}`}>
            {openPRs.length}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Merged This Month</p>
          <p className="text-2xl font-bold mt-0.5 text-violet-400">{totalMergedThisMonth}</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Total Fetched</p>
          <p className="text-2xl font-bold mt-0.5 text-foreground">{mergedPRs.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Contributors</p>
          <p className="text-2xl font-bold mt-0.5 text-sky-400">{contributors.length}</p>
        </div>
      </div>

      {mergeError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <strong>GitHub API error:</strong> {mergeError}
        </div>
      )}

      {/* Open PRs */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitPullRequest className="h-4 w-4 text-amber-400" />
              <CardTitle className="text-sm font-medium">Waiting to Merge</CardTitle>
            </div>
            {openPRs.length > 0 && (
              <Badge variant="warning">{openPRs.length} open</Badge>
            )}
          </div>
          <CardDescription className="text-xs">Open pull requests — goes amber after 3 days, red after 7.</CardDescription>
        </CardHeader>
        <CardContent>
          <OpenPRsSection prs={openPRs} />
        </CardContent>
      </Card>

      {/* Merge activity chart + Contributors side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-violet-400" />
              <CardTitle className="text-sm font-medium">Merge Activity</CardTitle>
            </div>
            <CardDescription className="text-xs">PRs merged per week over the last 12 weeks.</CardDescription>
          </CardHeader>
          <CardContent>
            <MergeActivityChart data={weeklyActivity} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-sky-400" />
              <CardTitle className="text-sm font-medium">Contributors</CardTitle>
            </div>
            <CardDescription className="text-xs">Ranked by merged PRs.</CardDescription>
          </CardHeader>
          <CardContent className="px-4 pt-0">
            <ContributorLeaderboard contributors={contributors} />
          </CardContent>
        </Card>
      </div>

      {/* Full merged PR feed */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-violet-400" />
            <CardTitle className="text-sm font-medium">Merged PRs</CardTitle>
          </div>
          <CardDescription className="text-xs">Last {mergedPRs.length} merged pull requests with size labels. Search or filter by author.</CardDescription>
        </CardHeader>
        <CardContent>
          <PRFeed prs={mergedPRs} />
        </CardContent>
      </Card>
    </div>
  );
}

export default function PullRequestsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading pull requests…
          </div>
        }
      >
        <PullRequestsContent />
      </Suspense>
    </div>
  );
}
