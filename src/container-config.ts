/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

/**
 * Per-MCP-server config. Stdio (default) runs a subprocess inside the
 * container; http/sse hit a remote URL with credentials injected at the
 * HTTPS_PROXY layer by OneCLI — the container never sees the token.
 */
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

export interface StdioMcpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

export interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

export interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  feedback_enabled?: boolean;
  query_strategy?: 'raw' | 'heuristic' | 'llm';
  recall_scope?: 'self' | 'all-groups' | string[];
}

export function isFeedbackEnabled(cfg: MemoryConfig | undefined): boolean {
  if (!cfg?.enabled) return false;
  return cfg.feedback_enabled !== false;
}

export function getQueryStrategy(cfg: MemoryConfig | undefined): 'raw' | 'heuristic' | 'llm' {
  return cfg?.query_strategy ?? 'raw';
}

export function getRecallScope(cfg: MemoryConfig | undefined): 'self' | 'all-groups' | string[] {
  return cfg?.recall_scope ?? 'self';
}

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;

  /**
   * Name of the env var on the host that holds this group's GitHub token.
   * If unset, container-runner derives a name from the folder
   * (`GITHUB_TOKEN_<FOLDER_UPPER>` with dashes as underscores) and falls
   * back to `GITHUB_TOKEN`.
   */
  githubTokenEnv?: string;

  /**
   * Plugin subdir names under `~/plugins/` to NOT mount for this group.
   * Plugins under `~/plugins/` are mounted into every container by default
   * (RO at `/workspace/plugins/<name>`). Use this when a group shouldn't
   * have access to a specific plugin — e.g., security-sensitive agents
   * excluding the `codex` plugin to avoid handing them a CLI with the
   * host's Codex OAuth session.
   */
  excludePlugins?: string[];

  /**
   * Named MCP servers to suppress for this group. Universal MCPs
   * (granola, deepwiki, context7, exa, pocket) are injected by default
   * in every container; add entries here to opt OUT per group.
   */
  excludeMcpServers?: string[];

  /**
   * When true, mount the host `~/.codex` directory into the container as
   * read-only so the Codex CLI can use the host's OAuth session. SECURITY:
   * any in-container code with shell access can read the OAuth token; a
   * compromised agent could exfiltrate it. Default OFF — opt in only for
   * groups that specifically need Codex host auth (e.g., the Codex agent
   * provider, /codex:rescue use cases). Pre-2026-05-03 the mount was
   * unconditional and RW; the cross-tenant audit forced it opt-in + RO.
   */
  codexHostAuth?: boolean;

  /**
   * When true, sets `GITNEXUS_INJECT_AGENTS_MD=true` in the container so
   * GitNexus auto-injects AGENTS.md into repos the agent works on.
   */
  gitnexusInjectAgentsMd?: boolean;

  /**
   * When true, sets `OLLAMA_ADMIN_TOOLS=true` to enable the Ollama
   * admin-level MCP tools (model management, etc.).
   */
  ollamaAdminTools?: boolean;

  /**
   * Per-group default model when the agent uses the bare `opus` alias.
   * Resolves the SDK's opus-alias short-circuit ANTHROPIC_DEFAULT_OPUS_MODEL.
   * Overrides the install-wide DEFAULT_OPUS_MODEL constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-m <model>` flags override on top of that.
   */
  defaultModel?: string;

  /**
   * Per-group default reasoning effort when the agent doesn't pass
   * `-e <level>`. One of 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
   * Overrides the install-wide DEFAULT_EFFORT constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-e <level>` flags override on top of that.
   */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /**
   * Per-agent-group default tone profile name (matches a file under
   * `tone-profiles/<name>.md`). Acts as the fallback when a per-channel
   * wiring doesn't set `default_tone` on `messaging_group_agents`.
   */
  tone?: string;

  /**
   * Per-agent credential/tool allowlist. Each entry is either a bare tool
   * name (`snowflake`) or scoped (`snowflake:sunday`, `aws:apollo`).
   * Omit to grant every credential surface; include to filter per-tool
   * before mount. Supported tool names: gmail, gmail-readonly, calendar,
   * google-workspace, snowflake, aws, gcloud, dbt, github, render,
   * browser-auth.
   */
  tools?: string[];

  /**
   * Per-provider sticky config for the agent that runs in this group.
   * Populated by `create_agent`'s host handler after container-side Zod
   * validation (decision D4 — container is the validation authority).
   * Each provider reads only its own slice.
   *
   * Source of truth for valid keys per provider:
   *   container/agent-runner/src/providers/<name>.ts — see the exported
   *   `<name>ConfigSchema`. Currently:
   *     - 'claude': { model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }
   *     - 'codex':  { model?: string, reasoning_effort?: 'low'|'medium'|'high' }
   *     - Others (e.g. opencode, mock): no configSchema — must be empty {}.
   *
   * See decision D4 / D11 in .context/specs/create-agent-provider/decisions.yaml.
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Memory integration. When enabled, the host mounts the per-group mnemon store
   * filesystem-RW into the container (sqlite needs journal/lock files) but sets
   * `MNEMON_READ_ONLY=1` so the wrapper rejects write subcommands. Container can
   * `mnemon recall` (read), but writes go through the host daemon. See
   * `docs/memory.md` § Architecture and `data/systemd/nanoclaw-memory-daemon.service`.
   */
  memory?: MemoryConfig;
}

function emptyConfig(): ContainerConfig {
  // memory.enabled defaults to true for new groups — operator opt-out via
  // `disable-memory.ts <group>` for surfaces that shouldn't accumulate
  // facts (e.g., one-shot service accounts, ephemeral test groups). The
  // initial container.json carries the flag so the daemon picks it up on
  // its next 60s sweep, and the container's MNEMON_STORE env gets set on
  // first spawn so memory-capture hooks are wired without an extra step.
  //
  // tools defaults to `[]` (default-deny) for new groups so a child
  // spawned via create_agent doesn't inherit every credential surface
  // (snowflake, gws, aws, dbt, etc.). Operators add tool entries to
  // explicitly grant credential access. Pre-2026-05-03 this field was
  // omitted, which made `isToolEnabled()` allow every tool — pairing
  // dangerously with create_agent. See cross-tenant audit.
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
    memory: { enabled: true },
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      githubTokenEnv: raw.githubTokenEnv,
      excludePlugins: raw.excludePlugins,
      codexHostAuth: raw.codexHostAuth,
      excludeMcpServers: raw.excludeMcpServers,
      gitnexusInjectAgentsMd: raw.gitnexusInjectAgentsMd,
      ollamaAdminTools: raw.ollamaAdminTools,
      defaultModel: raw.defaultModel,
      defaultEffort: raw.defaultEffort,
      tone: raw.tone,
      tools: raw.tools,
      providerConfig: raw.providerConfig,
      memory: (raw as Record<string, unknown>).memory as MemoryConfig | undefined,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
