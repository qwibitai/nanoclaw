/**
 * App root. Theme provider → Query provider → Router → AppShell.
 *
 * Hash routing (not HTML5 history) because nanoclaw's HTTP server
 * doesn't need to know about SPA routes — every URL fragment is a
 * client-side navigation and /dashboard itself serves the same shell
 * for every view. See src/main.tsx for the bootstrap hash-rewrite
 * shim that preserves legacy bare-fragment URLs from Pip-generated
 * Telegram links.
 *
 * SSE bridge is started once at mount via a top-level useEffect.
 */

import { lazy, Suspense, useEffect } from "react";
import {
  createHashRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/shell/AppShell";
import { ChunkErrorBoundary } from "@/components/shell/ChunkErrorBoundary";
import { queryClient } from "@/lib/query";
import { connectSse } from "@/lib/sse";
import { applyThemeFromSystem } from "@/lib/theme";
import { Placeholder } from "@/views/placeholder";
import { ReportsView } from "@/views/ReportsView";
import { ReportDetailView } from "@/views/ReportDetailView";
import { DevTasksView } from "@/views/DevTasksView";
import { TasksView } from "@/views/TasksView";
import { MealsView } from "@/views/MealsView";

// Vault ships D3 (+~30kb gzipped). Lazy-loaded so users who open
// /reports directly don't pay for it.
const VaultView = lazy(() =>
  import("@/views/VaultView").then((m) => ({ default: m.VaultView })),
);

function VaultRoute() {
  return (
    <ChunkErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
            Loading vault…
          </div>
        }
      >
        <VaultView />
      </Suspense>
    </ChunkErrorBoundary>
  );
}

const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/vault" replace /> },
      {
        path: "vault",
        element: <VaultRoute />,
      },
      {
        path: "meals",
        element: <MealsView />,
      },
      {
        path: "tasks",
        element: <TasksView />,
      },
      {
        path: "devtasks",
        element: <DevTasksView />,
      },
      {
        path: "reports",
        element: <ReportsView />,
      },
      {
        path: "reports/:id",
        element: <ReportDetailView />,
      },
      {
        path: "*",
        element: (
          <Placeholder title="Not found" eyebrow="404" />
        ),
      },
    ],
  },
]);

function App() {
  useEffect(() => {
    const teardownTheme = applyThemeFromSystem();
    const teardownSse = connectSse(queryClient);
    return () => {
      teardownTheme();
      teardownSse();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

export default App;
