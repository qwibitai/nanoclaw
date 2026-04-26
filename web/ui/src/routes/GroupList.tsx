import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listGroups, type AgentGroupView } from "../lib/api.ts";

export function GroupList() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; groups: AgentGroupView[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((groups) => !cancelled && setState({ kind: "ok", groups }))
      .catch(
        (err) =>
          !cancelled &&
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <div className="status-banner">Loading agent groups…</div>;
  }

  if (state.kind === "error") {
    return (
      <div>
        <div className="error-banner">
          Couldn't load groups: <code>{state.message}</code>
        </div>
        <p className="muted">
          Make sure the web server is running:{" "}
          <code>pnpm --filter @paraclaw/web-server dev</code>. It needs the
          NanoClaw central DB at <code>data/v2.db</code> — that gets created
          the first time you run <code>pnpm setup</code> or{" "}
          <code>pnpm dev</code>.
        </p>
      </div>
    );
  }

  if (state.groups.length === 0) {
    return (
      <div>
        <h2>Agent groups</h2>
        <div className="empty">
          <p>No agent groups yet.</p>
          <p className="dim">
            NanoClaw spawns agent groups via channel skills (e.g.{" "}
            <code>/init-first-agent</code>) or the setup flow. Once you have
            one, refresh this page to manage its vault attachment here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Agent groups ({state.groups.length})</h2>
      {state.groups.map((g) => (
        <Link
          key={g.id}
          to={`/groups/${encodeURIComponent(g.folder)}`}
          className="group-row"
        >
          <div className="name">
            {g.name}
            {g.vault ? (
              <span className="tag">{g.vault.scope}</span>
            ) : (
              <span className="tag muted">no vault</span>
            )}
          </div>
          <div className="meta">
            folder: <code>{g.folder}</code>
            {g.agent_provider && (
              <> &middot; provider: <code>{g.agent_provider}</code></>
            )}
            {g.vault && (
              <>
                {" "}
                &middot; vault:{" "}
                <code>{g.vault.vaultBaseUrl}</code>
              </>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
