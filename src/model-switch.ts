/**
 * Per-agent-group model selection.
 *
 * `agent_groups.model` is the source of truth. At spawn time, the host
 * passes the resolved model into container.json so the in-container
 * provider reads it from the RO mount.
 *
 * Hint lists are *not* a contract — codex/anthropic both reject unknown
 * models server-side with a clear error message that surfaces in chat.
 * The list is purely so the `/model` reply has nameable suggestions.
 */
import { getAgentGroupByFolder, updateAgentGroup } from './db/agent-groups.js';

export interface ModelHint {
  name: string;
  note: string;
}

const CODEX_HINTS: ModelHint[] = [
  { name: 'gpt-5.5', note: 'strongest — complex coding, research, knowledge work' },
  { name: 'gpt-5.4', note: 'rollout fallback if 5.5 unavailable' },
  { name: 'gpt-5.4-mini', note: 'fast/cheap for light tasks, subagents' },
  { name: 'gpt-5.3-codex', note: 'older codex-tuned' },
];

const CLAUDE_HINTS: ModelHint[] = [
  { name: 'claude-opus-4-7', note: 'Opus — strongest reasoning' },
  { name: 'claude-sonnet-4-6', note: 'Sonnet — balanced' },
  { name: 'claude-haiku-4-5-20251001', note: 'Haiku — fast/cheap' },
];

export function hintsForProvider(provider: string | null): ModelHint[] {
  switch ((provider || 'claude').toLowerCase()) {
    case 'codex':
      return CODEX_HINTS;
    case 'claude':
      return CLAUDE_HINTS;
    default:
      return [];
  }
}

export function getCurrentModel(folder: string): { provider: string | null; model: string | null } | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return null;
  return { provider: group.agent_provider, model: group.model };
}

/**
 * Resolve the effective model the next container spawn will use, mirroring
 * the precedence in the in-container provider:
 *   group.model → env (CODEX_MODEL/ANTHROPIC_MODEL) → provider's hardcoded default
 */
export function resolveEffectiveModel(group: { agent_provider: string | null; model: string | null }): string {
  if (group.model) return group.model;
  const provider = (group.agent_provider || 'claude').toLowerCase();
  if (provider === 'codex') {
    return process.env.CODEX_MODEL || 'gpt-5.5';
  }
  if (provider === 'claude') {
    return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  }
  return '(unknown)';
}

export function setModel(folder: string, model: string | null): boolean {
  const group = getAgentGroupByFolder(folder);
  if (!group) return false;
  updateAgentGroup(group.id, { model });
  return true;
}
