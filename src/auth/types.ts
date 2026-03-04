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

/** Pluggable per-service credential provider. */
export interface CredentialProvider {
  /** File basename: 'claude_oauth', 'anthropic_api_key' */
  service: string;
  displayName: string;

  /** Does this scope have usable credentials? */
  hasAuth(scope: string): boolean;

  /** Produce env vars for a container run. */
  provision(scope: string): { env: Record<string, string> };

  /** After flow completes, parse raw result and save to store. */
  storeResult(scope: string, result: FlowResult): void;

  /** Refresh expired credentials (e.g. spawn container to let CLI refresh OAuth). */
  refresh?(scope: string): Promise<boolean>;

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
  provider: CredentialProvider;
  run(ctx: AuthContext): Promise<FlowResult | null>;
}

/** Options for exec() in auth context. */
export interface AuthExecOpts {
  /** Additional readonly bind mounts as [hostPath, containerPath] pairs. */
  extraMounts?: Array<[string, string]>;
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
  /** Polls main group messages. Returns null on timeout. */
  receive(timeoutMs?: number): Promise<string | null>;
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
