import { Suspense } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { getAllTasksWithFullLogs, getTaskStats } from "@/lib/nanoclaw";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JobStatsRow } from "@/components/cron-jobs/JobStatsRow";
import { HealthSparkline } from "@/components/cron-jobs/HealthSparkline";
import { RunHistoryTable } from "@/components/cron-jobs/RunHistoryTable";
import { RunNowButton } from "@/components/cron-jobs/RunNowButton";
import { WeekSchedule } from "@/components/cron-jobs/WeekSchedule";
import { formatSchedule, getTaskDisplayName } from "@/lib/nanoclaw";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function CronJobsContent() {
  const tasks = getAllTasksWithFullLogs();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Cron Jobs
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""} registered ·{" "}
            {tasks.filter((t) => t.status === "active").length} active
          </p>
        </div>
        <form action="/cron-jobs" method="GET">
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </form>
      </div>

      {/* Per-job sections */}
      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <Clock className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">No scheduled tasks registered</p>
        </div>
      ) : (
        tasks.map((task) => {
          const stats = getTaskStats(task.recent_runs);
          return (
            <div key={task.id} className="space-y-4">
              {/* Job header */}
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-foreground">
                      {getTaskDisplayName(task)}
                    </h2>
                    <Badge variant={task.status === "active" ? "success" : task.status === "paused" ? "warning" : "muted"}>
                      {task.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-xs font-mono text-muted-foreground">{formatSchedule(task)}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{task.context_mode} mode</span>
                    {task.last_run && (
                      <>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">
                          last run {formatDistanceToNow(new Date(task.last_run), { addSuffix: true })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <RunNowButton taskId={task.id} />
              </div>

              {/* Stats row */}
              <JobStatsRow stats={stats} />

              {/* Health sparkline */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Run Health — Last {task.recent_runs.length} runs</CardTitle>
                  <CardDescription className="text-xs">Each bar = one run. Green = success, red = error. Height = duration.</CardDescription>
                </CardHeader>
                <CardContent>
                  <HealthSparkline runs={task.recent_runs} maxBars={20} />
                </CardContent>
              </Card>

              {/* Run history table */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Run History</CardTitle>
                  <CardDescription className="text-xs">Click any row to expand the full output log.</CardDescription>
                </CardHeader>
                <CardContent className="p-0 pb-1">
                  <RunHistoryTable runs={task.recent_runs} />
                </CardContent>
              </Card>

              {/* Separator between jobs if multiple */}
              <div className="border-t border-border" />
            </div>
          );
        })
      )}

      {/* 7-day schedule */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Next 7 Days Schedule
          </CardTitle>
          <CardDescription className="text-xs">Upcoming scheduled fire times for all active cron jobs.</CardDescription>
        </CardHeader>
        <CardContent>
          <WeekSchedule tasks={tasks} />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CronJobsPage() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading cron jobs…
          </div>
        }
      >
        <CronJobsContent />
      </Suspense>
    </div>
  );
}
