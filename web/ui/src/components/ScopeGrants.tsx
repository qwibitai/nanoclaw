import type { VaultScope } from "../lib/api.ts";

const READ_TOOLS = ["query-notes", "list-tags", "find-path", "vault-info"] as const;
const WRITE_TOOLS = ["create-note", "update-note", "delete-note", "update-tag", "delete-tag"] as const;

export const SCOPE_OPTIONS: { value: VaultScope; label: string }[] = [
  { value: "vault:read", label: "vault:read — query, can't modify" },
  { value: "vault:write", label: "vault:write — capture and update notes" },
  { value: "vault:admin", label: "vault:admin — full access (use sparingly)" },
];

export function scopeGrants(scope: VaultScope): {
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

export function ScopeGrants({ scope }: { scope: VaultScope }) {
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
