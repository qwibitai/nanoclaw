import { Clock, CheckCircle2, XCircle, PauseCircle } from "lucide-react";
import type { TaskWithLogs } from "@/lib/nanoclaw";

interface Props {
  tasks: TaskWithLogs[];
}

export function StatsBar({ tasks }: Props) {
  const active = tasks.filter((t) => t.status === "active").length;
  const paused = tasks.filter((t) => t.status === "paused").length;

  const allRuns = tasks.flatMap((t) => t.recent_runs);
  const recentRuns = allRuns
    .sort((a, b) => new Date(b.run_at).getTime() - new Date(a.run_at).getTime())
    .slice(0, 20);

  const successRuns = recentRuns.filter((r) => r.status === "success").length;
  const errorRuns = recentRuns.filter((r) => r.status === "error").length;

  const stats = [
    {
      label: "Active Tasks",
      value: active,
      icon: Clock,
      color: "text-primary",
      bg: "bg-primary/10",
    },
    {
      label: "Paused",
      value: paused,
      icon: PauseCircle,
      color: "text-amber-400",
      bg: "bg-amber-400/10",
    },
    {
      label: "Recent Successes",
      value: successRuns,
      icon: CheckCircle2,
      color: "text-emerald-400",
      bg: "bg-emerald-400/10",
    },
    {
      label: "Recent Errors",
      value: errorRuns,
      icon: XCircle,
      color: "text-red-400",
      bg: "bg-red-400/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4"
        >
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.bg}`}>
            <stat.icon className={`h-4 w-4 ${stat.color}`} />
          </div>
          <div>
            <p className="text-xl font-semibold text-foreground">{stat.value}</p>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
