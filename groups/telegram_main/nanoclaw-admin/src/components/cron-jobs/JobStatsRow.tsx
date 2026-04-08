import { TrendingUp, Clock, Flame, BarChart2 } from "lucide-react";
import type { TaskStats } from "@/lib/nanoclaw";

function StatChip({ icon: Icon, label, value, color }: {
  icon: React.ElementType;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <Icon className={`h-4 w-4 shrink-0 ${color}`} />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold text-foreground">{value}</p>
      </div>
    </div>
  );
}

export function JobStatsRow({ stats }: { stats: TaskStats }) {
  const avgSec = (stats.avgDurationMs / 1000).toFixed(1);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatChip
        icon={BarChart2}
        label="Total Runs"
        value={stats.totalRuns.toLocaleString()}
        color="text-primary"
      />
      <StatChip
        icon={TrendingUp}
        label="Success Rate"
        value={stats.totalRuns === 0 ? "—" : `${stats.successRate}%`}
        color={stats.successRate >= 90 ? "text-emerald-400" : stats.successRate >= 70 ? "text-amber-400" : "text-red-400"}
      />
      <StatChip
        icon={Clock}
        label="Avg Duration"
        value={stats.totalRuns === 0 ? "—" : `${avgSec}s`}
        color="text-sky-400"
      />
      <StatChip
        icon={Flame}
        label="Current Streak"
        value={stats.totalRuns === 0 ? "—" : `${stats.currentStreak} ✓`}
        color={stats.currentStreak >= 5 ? "text-orange-400" : "text-muted-foreground"}
      />
    </div>
  );
}
