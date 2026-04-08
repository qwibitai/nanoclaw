/**
 * TanStack Query client + query-key factory for the FamBot dashboard.
 *
 * The query keys mirror the /dashboard/api/* routes 1:1 so the SSE
 * bridge in ./sse.ts can translate server-broadcast event types into
 * targeted cache invalidations without any extra mapping layer.
 *
 * Retry policy is tuned to skip 4xx (the 404 path in ReportDetailView
 * surfaces immediately instead of retrying three times before showing
 * the "Report not found" state) and to do a single retry for 5xx /
 * network errors. Defaults are otherwise left alone — the SSE
 * invalidation feed handles freshness so there's no reason to touch
 * staleTime/gcTime.
 */

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry 4xx — a 404 is a 404, not a transient failure.
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          return false;
        }
        return failureCount < 1;
      },
      retryDelay: 1000,
    },
  },
});

/**
 * Stable query key factory. Views reference these constants directly
 * rather than hand-typing tuple literals so a rename is a single-file
 * change and the SSE → invalidate mapping can compile-check against
 * the same set.
 */
export const queryKeys = {
  vault: ["vault"] as const,
  devtasks: ["devtasks"] as const,
  tasks: ["tasks"] as const,
  reports: ["reports"] as const,
  report: (id: string) => ["report", id] as const,
  meals: ["meals"] as const,
};
