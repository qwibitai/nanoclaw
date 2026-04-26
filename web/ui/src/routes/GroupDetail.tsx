import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  attachVault,
  detachVault,
  getGroup,
  type AgentGroupView,
  type VaultScope,
} from "../lib/api.ts";

const SCOPE_OPTIONS: { value: VaultScope; label: string }[] = [
  { value: "vault:read", label: "vault:read — query, can't modify" },
  { value: "vault:write", label: "vault:write — capture and update notes" },
  { value: "vault:admin", label: "vault:admin — full access (use sparingly)" },
];

const READ_TOOLS = ["query-notes", "list-tags", "find-path", "vault-info"] as const;
const WRITE_TOOLS = ["create-note", "update-note", "delete-note", "update-tag", "delete-tag"] as const;

function scopeGrants(scope: VaultScope): {
  summary: string;
  granted: readonly string[];
  withheld: readonly string[];
  adminNote?: string;
} {
  if (scope === "vault:read") {
    return {
      summary: "Read-only access. The agent can query the vault but cannot create, modify, or delete anything.",
      granted: READ_TOOLS,
      withheld: WRITE_TOOLS,
    };
  }
  if (scope === "vault:write") {
    return {
      summary: "Read + write. The agent can capture and update notes and tags, but cannot manage vault config or tokens.",
      granted: [...READ_TOOLS, ...WRITE_TOOLS],
      withheld: [],
    };
  }
  return {
    summary: "Full access including vault config (/.parachute/config*) and token management. Use sparingly.",
    granted: [...READ_TOOLS, ...WRITE_TOOLS],
    withheld: [],
    adminNote: "Admin tokens can read and write any path including vault config — only grant when the agent genuinely needs it.",
  };
}

export function GroupDetail() {
  const { folder } = useParams<{ folder: string }>();
  const [group, setGroup] = useState<AgentGroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Attach form state.
  const [scope, setScope] = useState<VaultScope>("vault:read");
  const [vaultBaseUrl, setVaultBaseUrl] = useState("http://127.0.0.1:1940/vault/default");
  const [pasteToken, setPasteToken] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const reload = useCallback(async () => {
    if (!folder) return;
    try {
      setLoading(true);
      const g = await getGroup(folder);
      setGroup(g);
      setError(null);
      // Default the token-label field to claw-<folder> when not set.
      if (!tokenLabel) setTokenLabel(`claw-${folder}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAttach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    setSubmitting(true);
    setFlash(null);
    try {
      const result = await attachVault(folder, {
        scope,
        vaultBaseUrl: vaultBaseUrl.trim().replace(/\/+$/, ""),
        tokenLabel: tokenLabel.trim() || undefined,
        token: pasteToken.trim() || undefined,
      });
      setGroup(result.group);
      setFlash({
        kind: "ok",
        text: result.mintedToken
          ? `Vault attached (server minted a fresh ${scope} token via parachute CLI).`
          : `Vault attached using your pasted token.`,
      });
      setPasteToken("");
    } catch (err) {
      setFlash({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const onDetach = async () => {
    if (!folder) return;
    if (!window.confirm("Detach vault from this agent group? Token is NOT revoked — that's a separate action.")) {
      return;
    }
    setSubmitting(true);
    setFlash(null);
    try {
      const updated = await detachVault(folder);
      setGroup(updated);
      setFlash({
        kind: "ok",
        text: "Vault detached. To revoke the token: parachute vault tokens revoke <label>",
      });
    } catch (err) {
      setFlash({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !group) {
    return (
      <div>
        <Link to="/" className="muted">← All groups</Link>
        <div className="skeleton skeleton-heading" style={{ marginTop: "1rem" }} />
        <div className="section">
          <div className="skeleton skeleton-line" style={{ width: "30%" }} />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" style={{ width: "70%" }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link to="/" className="muted">← All groups</Link>
        <div className="error-banner" style={{ marginTop: "1rem" }}>{error}</div>
        <div className="actions" style={{ marginTop: "1rem" }}>
          <button onClick={reload} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div>
        <Link to="/" className="muted">← All groups</Link>
        <div className="empty">Group not found.</div>
      </div>
    );
  }

  return (
    <div>
      <Link to="/" className="muted">← All groups</Link>
      <h2 style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        {group.name}
        {group.vault ? (
          <span className="tag">{group.vault.scope}</span>
        ) : (
          <span className="tag muted">no vault attached</span>
        )}
      </h2>

      {flash && (
        <div className={flash.kind === "ok" ? "status-banner" : "error-banner"}>
          {flash.text}
        </div>
      )}

      <div className="section">
        <h3>Agent group</h3>
        <div className="kv">
          <div>name</div><div>{group.name}</div>
          <div>folder</div><div><code>{group.folder}</code></div>
          <div>id</div><div><code>{group.id}</code></div>
          <div>provider</div><div>{group.agent_provider ?? <em className="dim">default</em>}</div>
          <div>created</div><div>{new Date(group.created_at).toLocaleString()}</div>
        </div>
      </div>

      {group.vault ? (
        <div className="section">
          <h3>Vault attachment</h3>
          <div className="kv">
            <div>vault url</div><div><code>{group.vault.vaultBaseUrl}</code></div>
            <div>scope</div><div><span className="tag">{group.vault.scope}</span></div>
            <div>token label</div><div><code>{group.vault.tokenLabel}</code></div>
            <div>attached</div><div>{new Date(group.vault.attachedAt).toLocaleString()}</div>
          </div>
          <hr className="sep" />
          <div className="dim" style={{ marginBottom: "0.75rem" }}>
            The agent's container.json has a <code>parachute-vault</code> MCP entry pointing at this URL with a Bearer token. Detach removes the entry; the token stays valid until you revoke it via{" "}
            <code>parachute vault tokens revoke {group.vault.tokenLabel}</code>.
          </div>
          <button className="danger" onClick={onDetach} disabled={submitting}>
            {submitting ? "Working…" : "Detach vault"}
          </button>
        </div>
      ) : (
        <div className="section">
          <h3>Attach vault</h3>
          <form onSubmit={onAttach}>
            <div className="row">
              <label htmlFor="vaultBaseUrl">Vault URL</label>
              <input
                id="vaultBaseUrl"
                type="text"
                value={vaultBaseUrl}
                onChange={(e) => setVaultBaseUrl(e.target.value)}
                disabled={submitting}
              />
              <p className="dim">
                The agent will reach this at{" "}
                <code>{vaultBaseUrl.replace(/\/+$/, "")}/mcp</code>. Default
                is the local vault at <code>http://127.0.0.1:1940/vault/default</code>.
              </p>
            </div>

            <div className="row">
              <label htmlFor="scope">Scope</label>
              <select
                id="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as VaultScope)}
                disabled={submitting}
              >
                {SCOPE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="dim">
                Token capability — the agent literally cannot exceed this. Default <code>vault:read</code>.
              </p>
              <ScopeGrants scope={scope} />
            </div>

            <div className="row">
              <label htmlFor="tokenLabel">Token label</label>
              <input
                id="tokenLabel"
                type="text"
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                disabled={submitting}
                placeholder={`claw-${folder}`}
              />
              <p className="dim">
                Used for revocation. Default: <code>claw-{folder}</code>.
              </p>
            </div>

            <div className="row">
              <label htmlFor="pasteToken">Paste an existing token (optional)</label>
              <input
                id="pasteToken"
                type="text"
                value={pasteToken}
                onChange={(e) => setPasteToken(e.target.value)}
                disabled={submitting}
                placeholder="pvt_…  (leave blank to mint a fresh one via the parachute CLI)"
              />
              <p className="dim">
                When blank: the server runs{" "}
                <code>parachute vault tokens create --scope {scope} --label {tokenLabel || `claw-${folder}`}</code>
                {" "}for you. (Until vault OAuth is wired in Phase B; then
                you'll never see <code>pvt_…</code> tokens at all.)
              </p>
            </div>

            <div className="actions">
              <button type="submit" disabled={submitting}>
                {submitting ? "Attaching…" : "Attach vault"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="section">
        <h3>What the agent gets</h3>
        <p className="muted">
          When attached, the agent's container has a{" "}
          <code>parachute-vault</code> MCP server available with the nine
          vault tools: <code>query-notes</code>, <code>create-note</code>,{" "}
          <code>update-note</code>, <code>delete-note</code>,{" "}
          <code>list-tags</code>, <code>update-tag</code>,{" "}
          <code>delete-tag</code>, <code>find-path</code>,{" "}
          <code>vault-info</code>. Constrained by the scope you chose.
        </p>
        <p className="muted">
          Paraclaw doesn't impose a vault-note layout on the agent — the
          claw decides how to use vault access. (See{" "}
          <a
            href="https://github.com/ParachuteComputer/paraclaw/blob/main/docs/parachute-integration.md"
            target="_blank"
            rel="noreferrer"
          >
            docs/parachute-integration.md
          </a>
          .)
        </p>
      </div>
    </div>
  );
}

function ScopeGrants({ scope }: { scope: VaultScope }) {
  const grants = scopeGrants(scope);
  return (
    <div className="scope-grants">
      <p className="scope-grants-summary">{grants.summary}</p>
      <div className="scope-grants-tools">
        <div>
          <span className="scope-grants-label">Allows</span>
          <ul>
            {grants.granted.map((t) => (
              <li key={t}>
                <code>{t}</code>
              </li>
            ))}
          </ul>
        </div>
        {grants.withheld.length > 0 && (
          <div>
            <span className="scope-grants-label">Blocks</span>
            <ul>
              {grants.withheld.map((t) => (
                <li key={t} className="dim">
                  <code>{t}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {grants.adminNote && (
        <p className="scope-grants-warn">{grants.adminNote}</p>
      )}
    </div>
  );
}
