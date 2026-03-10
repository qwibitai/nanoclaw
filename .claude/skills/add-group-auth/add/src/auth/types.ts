/**
 * Per-group credential system — type definitions.
 */

/** On-disk credential file format at ~/.config/nanoclaw/credentials/{scope}/{service}.json */
export interface StoredCredential {
  auth_type: string;
  token: string; // encrypted: enc:<algo>:<keyHash16>:<iv>:<tag>:<ciphertext>, or plaintext
  expires_at: string | null;
  updated_at: string;
}

/** Re-export ProxyService so providers can reference it without importing credential-proxy directly. */
export type { ProxyService } from '../credential-proxy.js';

/** Pluggable per-service credential provider. */
export interface CredentialProvider {
  /** File basename: 'claude_oauth', 'anthropic_api_key' */
  service: string;
  displayName: string;

  /**
   * Proxy service this provider supplies credentials for.
   * When the provider is registered, its proxyService is also registered
   * with the credential proxy so it can handle requests at /<prefix>/.
   */
  proxyService?: import('../credential-proxy.js').ProxyService;

  /** Does this scope have usable credentials? */
  hasAuth(scope: string): boolean;

  /** Produce env vars for a container run. */
  provision(scope: string): { env: Record<string, string> };

  /** After flow completes, parse raw result and save to store. */
  storeResult(scope: string, result: FlowResult): void;

  /**
   * Refresh credentials if needed. Returns true if credentials are usable.
   * @param force - skip expiry check and always attempt refresh (e.g. after auth error).
   */
  refresh?(scope: string, force?: boolean): Promise<boolean>;

  /** Auth options for the reauth menu. */
  authOptions(scope: string): AuthOption[];

  /**
   * Import credentials from .env into the given scope.
   * Each provider reads its own keys from .env internally.
   * Called once at startup for the 'default' scope.
   */
  importEnv?(scope: string): void;
}

/** A single auth method offered by a provider. */
export interface AuthOption {
  label: string;
  /** Extra explanatory text shown below the label in the menu. */
  description?: string;
  provider: CredentialProvider;
  run(ctx: AuthContext): Promise<FlowResult | null>;
}

/** Options for exec() in auth context. */
export interface AuthExecOpts {
  /** Provider-specific bind mounts as [hostPath, containerPath, mode?] tuples. */
  mounts?: Array<[string, string, string?]>;
}

/** Context passed to auth option run(). */
export interface AuthContext {
  /** The credential scope (group folder or 'default'). */
  scope: string;
  /** Spawn a command inside a container. Caller doesn't know it's Docker. */
  exec(command: string[], opts?: AuthExecOpts): ExecHandle;
  /** Send/receive messages to the user through normal routing. */
  chat: ChatIO;
}

/**
 * ChatIO uses normal message routing — no special interception.
 * send() goes through the router (same path as container agent responses).
 * receive() polls main group messages, waiting for a user reply.
 */
export interface ChatIO {
  send(text: string): Promise<void>;
  /** Send without any prefix decoration (e.g. for PGP keys that must be copy-pasteable). */
  sendRaw(text: string): Promise<void>;
  /** Polls main group messages. Returns null on timeout. */
  receive(timeoutMs?: number): Promise<string | null>;
  /** Advance the message cursor past all current messages so the agent won't re-see them. */
  advanceCursor(): void;
}

/** Handle to a spawned container process. */
export interface ExecHandle {
  onStdout(cb: (chunk: string) => void): void;
  stdin: { write(data: string): void; end(): void };
  wait(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill(): void;
}

/** Result from an auth flow, before encryption. */
export interface FlowResult {
  auth_type: string;
  token: string; // plaintext — store will encrypt
  expires_at?: string | null;
}

/**
 * Sentinel value returned by an auth option's run() to signal that the
 * reauth menu should be shown again (e.g. when a prerequisite is missing).
 */
export const RESELECT: FlowResult = Object.freeze({
  auth_type: '__reselect__',
  token: '',
});
