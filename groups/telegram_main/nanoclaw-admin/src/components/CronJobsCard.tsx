import { Clock, CheckCircle2, XCircle, PauseCircle, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TaskWithLogs } from "@/lib/nanoclaw";
import { formatSchedule, getTaskDisplayName } from "@/lib/nanoclaw";
import { formatDistanceToNow } from "date-fns";

function StatusBadge({ status }: { status: string }) {
  if (status === "active")
    return <Badge variant="success">Active</Badge>;
  if (status === "paused")
    return <Badge variant="warning">Paused</Badge>;
  if (status === "completed")
    return <Badge variant="muted">Completed</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function LastRunIndicator({ task }: { task: TaskWithLogs }) {
  const lastRun = task.recent_runs[0];

  if (!lastRun) {
    return (
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <CalendarClock className="h-3 w-3" />
        Never run
      </span>
    );
  }

  const isSuccess = lastRun.status === "success";
  const timeAgo = formatDistanceToNow(new Date(lastRun.run_at), { addSuffix: true });
  const durationSec = (lastRun.duration_ms / 1000).toFixed(1);

  return (
    <span className={`text-xs flex items-center gap-1 ${isSuccess ? "text-emerald-400" : "text-red-400"}`}>
      {isSuccess ? (
        <CheckCircle2 className="h-3 w-3 shrink-0" />
      ) : (
        <XCircle className="h-3 w-3 shrink-0" />
      )}
      {timeAgo} · {durationSec}s
    </span>
  );
}

function NextRunInfo({ task }: { task: TaskWithLogs }) {
  if (!task.next_run || task.status !== "active") return null;
  const timeUntil = formatDistanceToNow(new Date(task.next_run), { addSuffix: true });
  return (
    <span className="text-xs text-muted-foreground">
      Next: {timeUntil}
    </span>
  );
}

interface Props {
  tasks: TaskWithLogs[];
}

export function CronJobsCard({ tasks }: Props) {
  const activeTasks = tasks.filter((t) => t.status === "active").length;
  const pausedTasks = tasks.filter((t) => t.status === "paused").length;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Scheduled Tasks</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {activeTasks > 0 && (
              <Badge variant="success">{activeTasks} active</Badge>
            )}
            {pausedTasks > 0 && (
              <Badge variant="warning">{pausedTasks} paused</Badge>
            )}
          </div>
        </div>
        <CardDescription>
          {tasks.length} task{tasks.length !== 1 ? "s" : ""} registered
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Clock className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No scheduled tasks yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-start justify-between px-6 py-4 hover:bg-accent/30 transition-colors">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={task.status} />
                    {task.status === "paused" && (
                      <PauseCircle className="h-3 w-3 text-amber-400" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground truncate">
                    {getTaskDisplayName(task)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                    {formatSchedule(task)}
                  </p>
                  <div className="flex items-center gap-3 mt-1.5">
                    <LastRunIndicator task={task} />
                    <NextRunInfo task={task} />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-muted-foreground">{task.group_folder}</p>
                  <p className="text-xs text-muted-foreground">{task.context_mode}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
