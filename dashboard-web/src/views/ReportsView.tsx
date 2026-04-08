/**
 * Reports list.
 *
 * One of two views inside the reading-experience anchor unit. Calm
 * stack of cards: title at body weight, summary at smaller muted
 * weight, relative time right-aligned. No avatars, no badges. Tap a
 * card to navigate to the detail view.
 *
 * Above-the-fold target on a 375x812 screen: ~4 cards visible.
 */

import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchReports } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { relativeTime, absoluteTime } from "@/lib/time";
import type { ReportMeta } from "@/types";

export function ReportsView() {
  const query = useQuery({
    queryKey: queryKeys.reports,
    queryFn: fetchReports,
  });

  return (
    <div className="px-5 py-6 md:px-8 md:py-8">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pip reports
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
      </div>

      {query.isPending && <ListSkeleton />}

      {query.isError && (
        <ErrorCard error={query.error} onRetry={() => query.refetch()} />
      )}

      {query.data && query.data.reports.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No reports yet.
        </div>
      )}

      {query.data && query.data.reports.length > 0 && (
        <div data-testid="reports-list" className="flex flex-col gap-3">
          {query.data.reports.map((r) => (
            <ReportCard key={r.id} report={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: ReportMeta }) {
  return (
    <Link
      to={`/reports/${report.id}`}
      className="group block rounded-[var(--radius)] border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.9375rem] font-medium tracking-tight leading-snug">
            {report.title}
          </h2>
          {report.summary && (
            <p className="mt-1 text-sm leading-snug text-muted-foreground line-clamp-2">
              {report.summary}
            </p>
          )}
        </div>
        <time
          className="shrink-0 text-xs text-muted-foreground"
          dateTime={report.created_at}
          title={absoluteTime(report.created_at)}
        >
          {relativeTime(report.created_at)}
        </time>
      </div>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="rounded-[var(--radius)] border border-border bg-card px-4 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="h-[0.9375rem] w-3/5 rounded-sm bg-muted" />
              <div className="mt-2 h-[0.875rem] w-4/5 rounded-sm bg-muted/70" />
            </div>
            <div className="h-3 w-10 shrink-0 rounded-sm bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorCard({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const message =
    error instanceof ApiError
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Unknown error";

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-4">
      <div className="text-sm font-medium">Couldn't load reports.</div>
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
