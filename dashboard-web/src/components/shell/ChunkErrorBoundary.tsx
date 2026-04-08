/**
 * Tiny error boundary for React.lazy chunk-load failures.
 *
 * After a deploy, any client viewing the dashboard with a stale
 * tab will request the OLD hashed asset URL (`/dashboard/assets/
 * VaultView-<oldhash>.js`) when they navigate to /vault. The new
 * server has a fresh hash so the request 404s, React.lazy throws
 * a `ChunkLoadError`, and without an ErrorBoundary the entire app
 * unmounts to a blank page.
 *
 * This boundary catches that specific class of error, shows a
 * single "reload to continue" button, and leaves everything else
 * to bubble up. Reload picks up the fresh `/dashboard` shell which
 * references the new hashed assets.
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk .* failed/i.test(error.message) ||
    /Failed to fetch dynamically imported module/i.test(error.message)
  );
}

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Re-throw anything that isn't a chunk load failure so the
    // surrounding React stack still sees real bugs in development
    // and so the next-up boundary (or React itself) can act.
    if (!isChunkLoadError(error)) {
      throw error;
    }
  }

  render() {
    if (this.state.error && isChunkLoadError(this.state.error)) {
      return (
        <div className="flex min-h-dvh items-center justify-center px-6">
          <div className="max-w-sm rounded-[var(--radius)] border border-border bg-card px-5 py-5 text-center">
            <div className="text-sm font-medium">
              Dashboard updated.
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              A newer version is live. Reload to continue.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md border border-border px-4 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
