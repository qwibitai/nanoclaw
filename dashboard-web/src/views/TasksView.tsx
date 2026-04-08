/**
 * Scheduled Tasks (cron) list.
 *
 * Stacked sections by task status (active / paused / completed),
 * active expanded by default. Schedule humanized when possible,
 * raw fallback otherwise.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchScheduledTasks } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { relativeTime } from "@/lib/time";
import { humanizeSchedule } from "@/lib/schedule";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn } from "@/lib/utils";
import type { ScheduledTask } from "@/types";

type Variant = "active" | "neutral" | "muted";

interface StatusGroup {
  status: ScheduledTask["status"];
  label: string;
  defaultExpanded: boolean;
  variant: Variant;
}

const GROUPS: StatusGroup[] = [
  { status: "active", label: "Active", defaultExpanded: true, variant: "active" },
  { status: "paused", label: "Paused", defaultExpanded: false, variant: "neutral" },
  { status: "completed", label: "Completed", defaultExpanded: false, variant: "muted" },
];

export function TasksView() {
  const query = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: fetchScheduledTasks,
  });

  return (
    <div className="px-5 py-6 md:px-8 md:py-8">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Scheduled
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tasks</h1>
      </div>

      {query.isPending && <Skeleton />}
      {query.isError && <ErrorCard error={query.error} onRetry={() => query.refetch()} />}

      {query.data && query.data.tasks.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No scheduled tasks.
        </div>
      )}

      {query.data && query.data.tasks.length > 0 && (
        <div className="flex flex-col gap-5">
          {GROUPS.map((group) => (
            <Section
              key={group.status}
              group={group}
              tasks={query.data.tasks.filter((t) => t.status === group.status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ group, tasks }: { group: StatusGroup; tasks: ScheduledTask[] }) {
  const [expanded, setExpanded] = useState(group.defaultExpanded);
  const sorted = [...tasks].sort((a, b) =>
    (a.next_run ?? "\uffff").localeCompare(b.next_run ?? "\uffff"),
  );

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-2 text-left"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            "h-3 w-3 text-muted-foreground transition-transform",
            expanded ? "rotate-90" : "rotate-0",
          )}
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <StatusBadge variant={group.variant}>{group.label}</StatusBadge>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </button>
      {expanded && tasks.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {sorted.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
      {expanded && tasks.length === 0 && (
        <div className="mt-2 px-3 text-xs text-muted-foreground">
          Nothing in {group.label.toLowerCase()}.
        </div>
      )}
    </section>
  );
}

function TaskCard({ task }: { task: ScheduledTask }) {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[0.75rem] text-muted-foreground">
            {humanizeSchedule(task)}
          </div>
          <p className="mt-1 text-[0.9375rem] leading-snug line-clamp-2">
            {task.prompt}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-[0.6875rem]">{task.group_folder}</span>
            {task.last_result && (
              <span
                className={cn(
                  "text-[0.6875rem]",
                  task.last_result === "success"
                    ? "text-muted-foreground"
                    : "text-accent",
                )}
              >
                last: {task.last_result}
              </span>
            )}
          </div>
        </div>
        {task.next_run && (
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={task.next_run}
          >
            {relativeTime(task.next_run)}
          </time>
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="h-4 w-24 rounded-sm bg-muted" />
          <div className="mt-3 flex flex-col gap-2">
            {[0, 1].map((j) => (
              <div
                key={j}
                className="rounded-[var(--radius)] border border-border bg-card px-4 py-3"
              >
                <div className="h-3 w-1/3 rounded-sm bg-muted/70" />
                <div className="mt-2 h-4 w-4/5 rounded-sm bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Unknown error";

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-4">
      <div className="text-sm font-medium">Couldn't load scheduled tasks.</div>
      <div className="mt-1 text-xs text-muted-foreground">{message}</div>
      <button
        onClick={onRetry}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
      >
        Retry
      </button>
    </div>
  );
}
