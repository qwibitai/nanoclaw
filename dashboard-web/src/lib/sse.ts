/**
 * SSE → React Query invalidation bridge.
 *
 * Opens a single long-lived EventSource against /dashboard/events
 * (emitted by nanoclaw/src/channels/dashboard-api.ts) and translates
 * the server event names into `queryClient.invalidateQueries` calls
 * against the matching queryKeys. Reconnects on error with a 5s
 * backoff, mirroring the behavior of the previous hand-rolled
 * dashboard.
 *
 * Event names are the source of truth on the server. Verified against
 * nanoclaw/src/channels/dashboard-api.ts lines 48-79:
 *
 *   devtasks_updated  → onDevTasksChanged → queryKeys.devtasks
 *   tasks_updated     → onScheduledTasksChanged → queryKeys.tasks
 *   reports_updated   → setReportsChangeCallback → queryKeys.reports
 *                        (also invalidates any open `['report', id]`)
 *   meals_updated     → fs.watch on meal plan files → queryKeys.meals
 *   vault_updated     → fs.watch on vault dir → queryKeys.vault
 *
 * NOT to be confused with the WebSocket broadcast channel in ios.ts,
 * which uses similar-looking names (`dev_tasks_updated`,
 * `scheduled_tasks_updated`) and is for the FamBot iOS app. That's a
 * separate stream on the same HTTP server.
 *
 * Security note: the SSE connection is source-checked once at HTTP
 * upgrade time via ios.ts:handleHttp (Tailscale + loopback only). If
 * the device leaves Tailscale mid-session, the underlying TCP drops
 * and the reconnect loop fires — which gets a fresh source check on
 * the next attempt. Self-healing, documented in the plan's Risks
 * section. Not a scope item for this devtask.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query";

type ServerEventType =
  | "devtasks_updated"
  | "tasks_updated"
  | "reports_updated"
  | "meals_updated"
  | "vault_updated";

interface ServerEventMessage {
  type: ServerEventType;
}

const RECONNECT_DELAY_MS = 5000;

/**
 * Open one persistent SSE connection for the app. Returns a teardown
 * function the caller can invoke on unmount (though in practice the
 * app root lives for the lifetime of the tab — teardown matters for
 * tests and HMR).
 */
export function connectSse(queryClient: QueryClient): () => void {
  let es: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    es = new EventSource("/dashboard/events");

    es.onmessage = (ev) => {
      let msg: ServerEventMessage;
      try {
        msg = JSON.parse(ev.data) as ServerEventMessage;
      } catch {
        // nanoclaw also sends a bare `"connected"` string on open,
        // which isn't JSON-parseable. Ignore anything we can't parse.
        return;
      }

      switch (msg.type) {
        case "vault_updated":
          void queryClient.invalidateQueries({ queryKey: queryKeys.vault });
          break;
        case "devtasks_updated":
          void queryClient.invalidateQueries({
            queryKey: queryKeys.devtasks,
          });
          break;
        case "tasks_updated":
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
          break;
        case "reports_updated":
          // Invalidate both the list and any open detail. React Query
          // matches `['report', ...]` prefix when invalidating
          // `['report']` (not exact: false).
          void queryClient.invalidateQueries({ queryKey: queryKeys.reports });
          void queryClient.invalidateQueries({ queryKey: ["report"] });
          break;
        case "meals_updated":
          void queryClient.invalidateQueries({ queryKey: queryKeys.meals });
          break;
        default: {
          // Unknown event type — ignore. A new server event name
          // should land in the same PR that updates this switch.
          const _exhaustive: never = msg.type;
          void _exhaustive;
        }
      }
    };

    let firstErrorAfterConnect = true;
    es.onopen = () => {
      firstErrorAfterConnect = true;
    };
    es.onerror = () => {
      // EventSource is noisy on network hiccups, so we don't spam
      // the console — but log the FIRST error after a connect so a
      // persistently broken endpoint is visible in DevTools instead
      // of indistinguishable from a healthy idle stream. Subsequent
      // errors during the same disconnect are silent.
      if (firstErrorAfterConnect) {
        firstErrorAfterConnect = false;
        // eslint-disable-next-line no-console
        console.warn(
          "[sse] connection lost, reconnecting in",
          RECONNECT_DELAY_MS,
          "ms",
        );
      }
      es?.close();
      es = null;
      // Single-pending-reconnect guard so multiple error events
      // during the same disconnect can't queue parallel reconnects.
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          open();
        }, RECONNECT_DELAY_MS);
      }
    };
  };

  open();

  return () => {
    disposed = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (es !== null) {
      es.close();
      es = null;
    }
  };
}
