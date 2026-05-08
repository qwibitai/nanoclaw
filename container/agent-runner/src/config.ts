/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  /** Optional model override; undefined = let the provider pick its default. */
  model?: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Pick the provider name with env-over-config precedence.
 *
 * The host resolves `sessions.agent_provider → agent_groups.agent_provider →
 * container.json.provider → 'claude'` and passes the result as AGENT_PROVIDER.
 * Env wins because container.json is shared across all sessions of an agent
 * group — per-session overrides can't round-trip through that file.
 *
 * Empty / whitespace-only values fall through to the next source.
 */
export function resolveProvider(envValue: string | undefined, configValue: unknown): string {
  const env = typeof envValue === 'string' ? envValue.trim() : '';
  if (env) return env;
  const cfg = typeof configValue === 'string' ? configValue.trim() : '';
  if (cfg) return cfg;
  return 'claude';
}

/**
 * Pick the model name with env-over-config precedence, same shape as
 * resolveProvider. The host resolves the full
 * `sessions.model → agent_groups.model → container.json.model` ladder and
 * passes the result as AGENT_MODEL; we read env first so per-session
 * overrides work without mutating the shared per-agent-group container.json.
 *
 * Returns undefined when nothing is set — downstream providers interpret
 * that as "use your SDK default" rather than substituting a hardcoded one.
 *
 * Model names are opaque: preserved case, just trimmed.
 */
export function resolveModel(envValue: string | undefined, configValue: unknown): string | undefined {
  const env = typeof envValue === 'string' ? envValue.trim() : '';
  if (env) return env;
  const cfg = typeof configValue === 'string' ? configValue.trim() : '';
  if (cfg) return cfg;
  return undefined;
}

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: resolveProvider(process.env.AGENT_PROVIDER, raw.provider),
    model: resolveModel(process.env.AGENT_MODEL, raw.model),
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
