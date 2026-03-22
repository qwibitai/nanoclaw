/**
 * Provider Plugin Interface
 *
 * Providers (e.g. Codex) implement this interface and live under plugins/<name>/.
 * The host-side module (plugins/<name>/host.ts) exports a default ProviderPlugin.
 * The container-side module (plugins/<name>/provider-<name>.ts) is copied into
 * the agent-runner-src directory at container spawn time.
 */

export interface ProviderPlugin {
  /** Provider name identifier, e.g. 'codex' */
  name: string;

  /** Get provider-specific secrets to pass to container via stdin */
  getSecrets(): Promise<Record<string, string>>;

  /** Check if this provider is ready (authenticated) */
  isAuthenticated(): boolean;

  /** Interactive auth/setup flow */
  setup(): Promise<void>;

  /** Container-side provider module filename (relative to plugin dir), e.g. 'provider-codex.ts' */
  containerProvider: string;
}
