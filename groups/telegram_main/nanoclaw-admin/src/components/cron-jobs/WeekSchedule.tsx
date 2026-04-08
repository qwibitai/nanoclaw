import { Calendar } from "lucide-react";
import { format, isToday, isTomorrow } from "date-fns";
import type { ScheduledTask } from "@/lib/nanoclaw";
import { getNextFireTimes } from "@/lib/nanoclaw";

function dayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  return format(date, "EEE, MMM d");
}

export function WeekSchedule({ tasks }: { tasks: ScheduledTask[] }) {
  const activeCronTasks = tasks.filter(
    (t) => t.status === "active" && t.schedule_type === "cron"
  );

  if (activeCronTasks.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        No active cron jobs scheduled
      </div>
    );
  }

  // Build a day → task[] map for the next 7 days
  const entries: { date: Date; task: ScheduledTask }[] = [];
  for (const task of activeCronTasks) {
    for (const date of getNextFireTimes(task, 7)) {
      entries.push({ date, task });
    }
  }
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Group by day
  const byDay = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = format(entry.date, "yyyy-MM-dd");
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(entry);
  }

  return (
    <div className="space-y-2">
      {Array.from(byDay.entries()).map(([key, dayEntries]) => (
        <div key={key} className="flex items-start gap-3">
          <div className="w-28 shrink-0 pt-0.5">
            <p className="text-xs font-medium text-foreground">{dayLabel(dayEntries[0].date)}</p>
            <p className="text-xs text-muted-foreground">{format(dayEntries[0].date, "MMM d")}</p>
          </div>
          <div className="flex-1 space-y-1">
            {dayEntries.map(({ date, task }, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
                <Calendar className="h-3 w-3 text-primary shrink-0" />
                <span className="text-xs text-foreground flex-1 truncate">
                  {task.prompt.split("\n")[0].slice(0, 50)}
                </span>
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {format(date, "HH:mm")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
