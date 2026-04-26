/**
 * Types for the Parachute integration. Narrow on purpose — the broader
 * NanoClaw types live unchanged in `src/types.ts` and `src/container-config.ts`.
 */

/**
 * Scopes the vault recognizes. Format: `<service>:<resource>:<action>` per
 * `parachute-patterns/patterns/oauth-scopes.md`. Today the vault ships with
 * the action-only set; per-vault-name resource scoping (`vault:<name>:read`)
 * is planned.
 */
export type VaultScope = 'vault:read' | 'vault:write' | 'vault:admin';

/**
 * What we record on the host side when a claw is attached to a vault. Lives
 * in `groups/<folder>/parachute.json` (separate from `container.json` so
 * upstream doesn't see Parachute fields it doesn't know how to handle).
 */
export interface VaultAttachment {
  /** Vault base URL — `http://127.0.0.1:1940/vault/<name>` (no trailing slash, no `/mcp` suffix). */
  vaultBaseUrl: string;
  /** The scope granted to this claw. */
  scope: VaultScope;
  /** Token label registered with the vault — used for revocation, not the secret. */
  tokenLabel: string;
  /** When this attachment was created. */
  attachedAt: string;
}

/**
 * Options for `buildVaultMcpServer` — what the helper needs to produce a
 * valid `McpServerConfig` HTTP entry.
 */
export interface BuildVaultMcpOpts {
  /** Vault base URL (no `/mcp` suffix — we append it). */
  vaultBaseUrl: string;
  /** The `pvt_…` token to use as Bearer auth. */
  vaultToken: string;
  /** Optional: in-context guidance that lands in the composed CLAUDE.md. */
  instructions?: string;
}
