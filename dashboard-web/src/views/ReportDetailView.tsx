/**
 * Report detail — the reading surface.
 *
 * This is the north-star surface of the entire rebuild. The prose
 * typography lives in .report-body (app.css). This component just
 * provides the page chrome (back link, title, byline) and mounts
 * <ReportBody> with the server-sanitized HTML.
 *
 * No TOC, no sticky header, no reading progress, no estimated
 * read-time badge. Plain by design (see plan Scope Boundaries).
 */

import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchReport } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { absoluteTime } from "@/lib/time";
import { ReportBody } from "@/components/reports/ReportBody";

export function ReportDetailView() {
  const { id } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: id ? queryKeys.report(id) : ["report", "unknown"],
    queryFn: () => {
      if (!id) throw new Error("missing report id");
      return fetchReport(id);
    },
    enabled: !!id,
  });

  return (
    <div className="px-5 py-6 md:px-8 md:py-8">
      {/* Back link is always visible, one tap, no hover-reveal. */}
      <Link
        to="/reports"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Reports
      </Link>

      {query.isPending && <DetailSkeleton />}

      {query.isError && <DetailError error={query.error} />}

      {query.data && (
        <article className="mt-4">
          <header className="mb-6 md:mb-8">
            <h1 className="text-2xl font-semibold tracking-tight leading-tight">
              {query.data.title}
            </h1>
            {query.data.summary && (
              <p className="mt-2 max-w-[68ch] text-[0.9375rem] text-muted-foreground">
                {query.data.summary}
              </p>
            )}
            <div className="mt-3 text-xs text-muted-foreground">
              <span>{query.data.created_by}</span>
              {" · "}
              <time
                dateTime={query.data.created_at}
                title={absoluteTime(query.data.created_at)}
              >
                {absoluteTime(query.data.created_at)}
              </time>
            </div>
          </header>
          <ReportBody html={query.data.body_html} />
        </article>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mt-4 animate-none">
      <div className="h-7 w-2/3 rounded-sm bg-muted" />
      <div className="mt-2 h-4 w-4/5 rounded-sm bg-muted/70" />
      <div className="mt-8 max-w-[68ch] space-y-3">
        {[96, 92, 80, 88, 94, 70, 60].map((w, i) => (
          <div
            key={i}
            className="h-[1.0625rem] rounded-sm bg-muted"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function DetailError({ error }: { error: unknown }) {
  // Distinguish 404 from other errors — different copy, different
  // response. 404 is the "report not found" case, not an error.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="mt-8 py-10 text-center">
        <div className="text-sm font-medium">Report not found.</div>
        <Link
          to="/reports"
          className="mt-2 inline-block text-xs text-primary underline underline-offset-2"
        >
          Back to reports
        </Link>
      </div>
    );
  }

  const message =
    error instanceof ApiError
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Unknown error";

  return (
    <div className="mt-6 rounded-[var(--radius)] border border-border bg-card px-4 py-4">
      <div className="text-sm font-medium">Couldn't load this report.</div>
      <div className="mt-1 text-xs text-muted-foreground">{message}</div>
    </div>
  );
}
