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
 * MCP server entry. Two shapes:
 *   - Stdio (legacy default): `command` + `args` + `env`. Type may be omitted
 *     or set to 'stdio'.
 *   - HTTP-based: `type: 'http' | 'sse' | 'streamableHttp'` + `url` + optional
 *     `headers`. The Claude Agent SDK natively supports 'http' (MCP Streamable
 *     HTTP) and 'sse'. We accept 'streamableHttp' as an explicit alias for
 *     'http' so configs read self-documenting; the agent-runner normalizes it
 *     to 'http' before handing to the SDK.
 *
 * Use {@link parseMcpServerConfig} to normalize+validate raw JSON input. It
 * fails fast on misconfiguration (both `command` and `url` set, `url` without
 * a recognized `type`, http/sse/streamableHttp without `url`, etc.).
 */
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse' | 'streamableHttp';
  // Stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP-based fields
  url?: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

const URL_TRANSPORTS = new Set(['http', 'sse', 'streamableHttp']);
const ALL_TYPES = new Set(['stdio', 'http', 'sse', 'streamableHttp']);

/**
 * Validate and normalize a raw MCP server config entry. Throws with a
 * server-name-prefixed message on any misconfiguration. Pure function — no
 * disk IO. Called from `readContainerConfig` per entry; bad entries are
 * dropped (with a console.error) so one typo doesn't take down the host.
 */
export function parseMcpServerConfig(name: string, raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`mcp[${name}]: config must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const type = r.type as McpServerConfig['type'] | undefined;
  const command = r.command as string | undefined;
  const url = r.url as string | undefined;

  if (type !== undefined && !ALL_TYPES.has(type)) {
    throw new Error(`mcp[${name}]: unknown type '${type}' (expected one of: stdio, http, sse, streamableHttp)`);
  }
  if (command && url) {
    throw new Error(`mcp[${name}]: cannot set both command and url — pick stdio (command) or url-based transport`);
  }
  if (url && type === undefined) {
    throw new Error(`mcp[${name}]: must set type to 'http' | 'sse' | 'streamableHttp' when using url`);
  }
  if (url && type === 'stdio') {
    throw new Error(`mcp[${name}]: type 'stdio' does not accept url`);
  }
  if (type && URL_TRANSPORTS.has(type) && !url) {
    throw new Error(`mcp[${name}]: type '${type}' requires url`);
  }
  if ((type === 'stdio' || type === undefined) && !command && !url) {
    throw new Error(`mcp[${name}]: must set either command (stdio) or url+type (http/sse/streamableHttp)`);
  }
  if ((type === 'stdio' || (type === undefined && !url)) && !command) {
    throw new Error(`mcp[${name}]: type 'stdio' requires command`);
  }

  const out: McpServerConfig = {};
  if (type !== undefined) out.type = type;
  if (command !== undefined) out.command = command;
  if (r.args !== undefined) out.args = r.args as string[];
  if (r.env !== undefined) out.env = r.env as Record<string, string>;
  if (url !== undefined) out.url = url;
  if (r.headers !== undefined) out.headers = r.headers as Record<string, string>;
  if (r.instructions !== undefined) out.instructions = r.instructions as string;
  return out;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
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
}

function emptyConfig(): ContainerConfig {
  // Default profile: read-only jibrain + tools mounts and the public QMD MCP.
  // Gives every newly auto-created agent group a useful knowledge floor:
  //   - QMD search over the public jibrain index ("memory" via mcp__qmd-public__query)
  //   - Direct read-only access to /jibrain and /tools inside the container
  //   - CLAUDE.local.md auto-memory (handled separately at spawn time)
  // Channels needing more (confidential domains, RW mounts, extra MCPs) edit
  // their own container.json after creation; this is the floor, not the ceiling.
  return {
    mcpServers: {
      'qmd-public': {
        // The QMD daemons on the host are wrapped by supergateway, exposing
        // MCP-over-HTTP (Streamable HTTP transport) at
        // host.docker.internal:7333/mcp. The Claude Agent SDK speaks
        // streamable-HTTP MCP natively, so the container connects directly
        // to that URL — no in-container supergateway bridge required.
        // ('streamableHttp' is normalized to the SDK's 'http' type by the
        // agent-runner; both spellings refer to MCP's Streamable-HTTP.)
        type: 'streamableHttp',
        url: 'http://host.docker.internal:7333/mcp',
        instructions: 'QMD public index \u2014 mcp__qmd-public__query',
      },
    },
    packages: { apt: [], npm: [] },
    additionalMounts: [
      { hostPath: '/Users/jibot/jibrain', containerPath: 'jibrain', readonly: true },
      { hostPath: '/Users/jibot/tools', containerPath: 'tools', readonly: true },
    ],
    skills: 'all',
  };
}

/** Test-only export so tests can assert the default-config shape without
 *  depending on disk IO. The real `emptyConfig` stays module-private. */
export const emptyConfigForTest = emptyConfig;

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Normalize a raw `mcpServers` map: validate each entry via
 * {@link parseMcpServerConfig}; drop (with console.error) any entry that
 * fails validation so a single typo doesn't take down the host.
 */
function normalizeMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    try {
      out[name] = parseMcpServerConfig(name, entry);
    } catch (err) {
      console.error(`[container-config] dropping invalid MCP server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
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
      mcpServers: normalizeMcpServers(raw.mcpServers),
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
