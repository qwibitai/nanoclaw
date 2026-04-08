import { Suspense } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { getAllTasksWithLogs } from "@/lib/nanoclaw";
import { getLastMergedPRs } from "@/lib/github";
import { CronJobsCard } from "@/components/CronJobsCard";
import { PullRequestsCard } from "@/components/PullRequestsCard";
import { StatsBar } from "@/components/StatsBar";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function DashboardContent() {
  const [tasks, prs] = await Promise.allSettled([
    getAllTasksWithLogs(),
    getLastMergedPRs(3),
  ]);

  const taskData = tasks.status === "fulfilled" ? tasks.value : [];
  const prData = prs.status === "fulfilled" ? prs.value : [];
  const taskError = tasks.status === "rejected" ? String(tasks.reason) : null;
  const prError = prs.status === "rejected" ? String(prs.reason) : null;

  const now = new Date();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {now.toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <form action="/" method="GET">
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
      <StatsBar tasks={taskData} />

      {/* Error banners */}
      {taskError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <strong>Cron jobs unavailable:</strong> {taskError}
        </div>
      )}
      {prError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <strong>GitHub PRs unavailable:</strong> {prError}
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CronJobsCard tasks={taskData} />
        <PullRequestsCard prs={prData} />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading dashboard…
          </div>
        }
      >
        <DashboardContent />
      </Suspense>
    </div>
  );
}
