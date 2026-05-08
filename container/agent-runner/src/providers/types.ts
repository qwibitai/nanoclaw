export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * True if the given error indicates the session has grown past the model's
   * context window. Poll-loop uses this to trigger in-turn recovery: clear
   * the continuation AND retry the same user message once with a fresh
   * session, so long-lived sessions don't dead-turn the user.
   *
   * Optional because not every provider has a distinct prompt-too-long
   * signal; those that don't should return false (poll-loop falls back to
   * the error-write path).
   */
  isContextTooLong?(err: unknown): boolean;

  /**
   * True if the given error is a transient upstream failure (429, rate
   * limit, overloaded, upstream_error, External provider returned).
   * Providers with credential rotation (multiple API keys) can use this
   * to trigger `rotateApiKey` before in-turn retry.
   */
  isRetryable?(err: unknown): boolean;

  /**
   * Advance to the next configured fallback credential (API key or OAuth
   * token). Returns `rotated: true` if a rotation happened, false if no
   * more fallbacks remain. The stored continuation is preserved across
   * rotations: the Claude Code SDK's `resume:` reads a LOCAL `.jsonl`
   * transcript (`~/.claude/projects/<hash>/<session>.jsonl`), and the
   * Anthropic API has no server-side session object that's bound to an
   * account — replaying the prior history under a new token works the
   * same as a `/login` mid-conversation in interactive Claude Code.
   *
   * Poll-loop pairs this with `isRetryable` to auto-recover from upstream
   * flakiness without dead-turning the user.
   */
  rotateApiKey?(): { rotated: boolean };
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];

  /**
   * Per-provider sticky config from container.json.providerConfig.
   * Validated by the create_agent MCP handler against the provider's
   * configSchema before it reaches the host for persistence (container is
   * the validation authority — see decision D4 / C11). Each provider reads
   * only its own slice in its constructor or query() method.
   */
  providerConfig?: Record<string, unknown>;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Per-turn model override. Passed to the SDK as the query's `model`
   * option. Providers that don't support per-query model selection should
   * ignore this. Effective model is: turn override → sticky override →
   * provider default.
   */
  model?: string;

  /** Per-turn effort level override (SDK option `effort`, first-class since Opus 4.6). */
  effort?: string;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

export interface StdioMcpServerConfig {
  /** Omitted `type` defaults to stdio for backward compat with the older config shape. */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Remote MCP server over HTTP(S). Used for OAuth-gated services where the
 * host's OneCLI gateway injects credentials via HTTPS_PROXY — the container
 * never sees the token. See `granola` wiring in the host container-runner.
 */
export interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | {
      type: 'result';
      text: string | null;
    }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   */
  | { type: 'compacted'; text: string };
