import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listGroups, type AgentGroupView } from "../lib/api.ts";

export function GroupList() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; groups: AgentGroupView[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

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
  }, [reloadKey]);

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Agent groups</h2>
        <ul className="skeleton-list" aria-busy="true" aria-label="Loading agent groups">
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
        </ul>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <h2>Agent groups</h2>
        <div className="error-banner">
          Couldn't load groups: <code>{state.message}</code>
        </div>
        <p className="muted">
          Make sure the web server is running:{" "}
          <code>cd web/server &amp;&amp; pnpm dev</code>. It needs the
          NanoClaw central DB at <code>data/v2.db</code> — that gets created
          the first time you run <code>pnpm setup</code> or{" "}
          <code>pnpm dev</code> from the repo root.
        </p>
        <div className="actions" style={{ marginTop: "1rem" }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  if (state.groups.length === 0) {
    return (
      <div>
        <h2>Agent groups</h2>
        <div className="empty empty-rich">
          <p className="empty-headline">No agent groups yet.</p>
          <p className="muted">
            Spin up your first agent group in a few clicks — or bootstrap from
            the CLI if you prefer.
          </p>
          <ul className="empty-paths">
            <li>
              <strong>New agent wizard</strong> —
              name + folder + optional vault attach.
            </li>
            <li>
              <strong>Claude Code skill</strong> —
              run <code>/init-first-agent</code> for channel pick + identity + welcome DM.
            </li>
            <li>
              <strong>CLI setup</strong> —
              run <code>pnpm setup</code> from the repo root.
            </li>
          </ul>
          <div className="actions" style={{ justifyContent: "center", marginTop: "1rem" }}>
            <Link to="/groups/new"><button>+ New agent group</button></Link>
            <button className="secondary" onClick={reload}>Refresh</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Agent groups ({state.groups.length})</h2>
        <Link to="/groups/new"><button>+ New agent group</button></Link>
      </div>
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
