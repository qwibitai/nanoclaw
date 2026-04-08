"use client";
import { ResponsiveContainer, BarChart, Bar, Cell, Tooltip } from "recharts";
import type { TaskRunLog } from "@/lib/nanoclaw";
import { formatDistanceToNow } from "date-fns";

interface Props {
  runs: TaskRunLog[];
  maxBars?: number;
}

export function HealthSparkline({ runs, maxBars = 14 }: Props) {
  const recent = [...runs].reverse().slice(-maxBars);

  if (recent.length === 0) {
    return (
      <div className="flex items-center gap-1 h-8">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-4 w-2 rounded-sm bg-muted opacity-30" />
        ))}
        <span className="text-xs text-muted-foreground ml-2">No runs yet</span>
      </div>
    );
  }

  const data = recent.map((run) => ({
    status: run.status,
    duration: run.duration_ms,
    run_at: run.run_at,
  }));

  return (
    <div className="h-10 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barCategoryGap="20%">
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as typeof data[0];
              return (
                <div className="rounded-lg border border-border bg-popover px-2 py-1.5 text-xs shadow-md">
                  <p className={d.status === "success" ? "text-emerald-400" : "text-red-400"}>
                    {d.status === "success" ? "✅ Success" : "❌ Error"}
                  </p>
                  <p className="text-muted-foreground">{(d.duration / 1000).toFixed(1)}s</p>
                  <p className="text-muted-foreground">{formatDistanceToNow(new Date(d.run_at), { addSuffix: true })}</p>
                </div>
              );
            }}
          />
          <Bar dataKey="duration" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.status === "success" ? "#10b981" : "#ef4444"}
                opacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
