/**
 * Dev Tasks list.
 *
 * IA (per plan Unit 7 / document-review): stacked sections by
 * status. In-flight (working + pr_ready) expanded by default because
 * that's what Boris is looking for on a glance. open /
 * needs_session / has_followups collapsed below with counts. done
 * collapsed at the bottom.
 *
 * Status order mirrors the old dashboard-devtasks-view.ts so the
 * grouping feels familiar, just reframed around "what's in flight"
 * as the default focus.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchDevTasks } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { relativeTime, absoluteTime } from "@/lib/time";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn } from "@/lib/utils";
import type { DevTask, DevTaskStatus } from "@/types";

interface StatusGroup {
  status: DevTaskStatus;
  label: string;
  defaultExpanded: boolean;
  variant: "active" | "neutral" | "attention" | "muted";
}

const GROUPS: StatusGroup[] = [
  { status: "working", label: "Working", defaultExpanded: true, variant: "active" },
  { status: "pr_ready", label: "PR Ready", defaultExpanded: true, variant: "attention" },
  { status: "open", label: "Open", defaultExpanded: false, variant: "neutral" },
  { status: "needs_session", label: "Needs Session", defaultExpanded: false, variant: "neutral" },
  { status: "has_followups", label: "Has Follow-ups", defaultExpanded: false, variant: "neutral" },
  { status: "done", label: "Done", defaultExpanded: false, variant: "muted" },
];

export function DevTasksView() {
  const query = useQuery({
    queryKey: queryKeys.devtasks,
    queryFn: fetchDevTasks,
  });

  return (
    <div className="px-5 py-6 md:px-8 md:py-8">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          In flight
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Dev Tasks</h1>
      </div>

      {query.isPending && <GroupsSkeleton />}

      {query.isError && <ErrorCard error={query.error} onRetry={() => query.refetch()} />}

      {query.data && query.data.tasks.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No dev tasks yet.
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

function Section({
  group,
  tasks,
}: {
  group: StatusGroup;
  tasks: DevTask[];
}) {
  const [expanded, setExpanded] = useState(group.defaultExpanded);
  const hasTasks = tasks.length > 0;
  const sorted = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

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
      {expanded && hasTasks && (
        <div className="mt-2 flex flex-col gap-2">
          {sorted.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
      {expanded && !hasTasks && (
        <div className="mt-2 px-3 text-xs text-muted-foreground">
          Nothing in {group.label.toLowerCase()}.
        </div>
      )}
    </section>
  );
}

function TaskCard({ task }: { task: DevTask }) {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">#{task.id}</span>
            <h2 className="text-[0.9375rem] font-medium leading-snug">
              {task.title}
            </h2>
          </div>
          {task.description && (
            <p className="mt-1 text-sm leading-snug text-muted-foreground line-clamp-2">
              {task.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {task.branch && (
              // break-all so long branch names like
              // `pip/task-58-investigate-dropped-messages` wrap
              // inside the card on narrow screens instead of
              // pushing the layout wider than the viewport.
              <span className="font-mono text-[0.6875rem] break-all">
                {task.branch}
              </span>
            )}
            {task.pr_url && (
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary underline underline-offset-2"
                onClick={(e) => e.stopPropagation()}
              >
                PR
              </a>
            )}
          </div>
        </div>
        <time
          className="shrink-0 text-xs text-muted-foreground"
          dateTime={task.updated_at}
          title={absoluteTime(task.updated_at)}
        >
          {relativeTime(task.updated_at)}
        </time>
      </div>
    </div>
  );
}

function GroupsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="h-4 w-24 rounded-sm bg-muted" />
          <div className="mt-3 flex flex-col gap-2">
            {[0, 1].map((j) => (
              <div
                key={j}
                className="rounded-[var(--radius)] border border-border bg-card px-4 py-3"
              >
                <div className="h-4 w-3/4 rounded-sm bg-muted" />
                <div className="mt-2 h-3 w-5/6 rounded-sm bg-muted/70" />
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
      <div className="text-sm font-medium">Couldn't load dev tasks.</div>
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
