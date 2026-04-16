/**
 * Built-in ACP peer factories — sensible defaults for common peers.
 *
 * @example
 * ```typescript
 * import { auto, codex, claudeCode } from '@boxlite-ai/agentlite/acp/peers';
 *
 * // Zero-config — discovers installed agents on the host:
 * acp: { peers: auto() }
 *
 * // Explicit:
 * acp: { peers: [codex(), claudeCode()] }
 * ```
 */

import { execFileSync } from 'node:child_process';
import type { AcpPeerConfig } from '../options.js';

// ─── Auto-discovery ─────────────────────────────────────────────────

/**
 * Registry of known coding agents.
 * Each entry maps a host binary to the factory that builds its AcpPeerConfig.
 * Order matters — first match wins if names collide.
 */
interface KnownAgent {
  /** Binary name to look for on $PATH. */
  bin: string;
  /** Build a peer config (called only when the binary is found). */
  build: () => AcpPeerConfig;
}

const KNOWN_AGENTS: KnownAgent[] = [
  { bin: 'claude', build: () => claudeCode() },
  { bin: 'codex', build: () => codex() },
];

/** Check whether a binary exists on $PATH. */
function binExists(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-discover installed coding agents on the host and return
 * peer configs with full-capability defaults.
 *
 * Scans `$PATH` for known agent CLIs (`claude`, `codex`, etc.).
 * Each discovered agent gets the same defaults as its explicit factory
 * (sandbox disabled, sensible model).
 *
 * @example
 * ```typescript
 * acp: { peers: auto() }
 * ```
 */
export function auto(): AcpPeerConfig[] {
  const peers: AcpPeerConfig[] = [];
  for (const agent of KNOWN_AGENTS) {
    if (binExists(agent.bin)) {
      peers.push(agent.build());
    }
  }
  return peers;
}

// ─── Codex ──────────────────────────────────────────────────────────

/** Options for the built-in Codex ACP peer. */
export interface CodexPeerOptions {
  /** Override the peer name. Default: "codex" */
  name?: string;
  /** Override the executable. Default: "npx" */
  command?: string;
  /** Extra CLI args appended after the built-in defaults. */
  extraArgs?: string[];
  /** Extra env vars merged with the built-in defaults. */
  env?: Record<string, string>;
  /** Description shown to the model. */
  description?: string;
  /** OpenAI model to use. Default: "o3" */
  model?: string;
  /**
   * Whether Codex should run with its built-in sandbox enabled.
   * Default: false — sandbox is set to `danger-full-access` so git,
   * file writes, and shell commands work out of the box.
   * Set to true to keep Codex's default sandbox restrictions.
   */
  sandbox?: boolean;
}

/**
 * Create a Codex ACP peer config with sensible defaults.
 *
 * Out of the box:
 * - Sandbox: `danger-full-access` (full filesystem + shell)
 * - Approvals: bypassed (`--dangerously-bypass-approvals-and-sandbox`)
 * - Model: o3
 *
 * Requires `OPENAI_API_KEY` in the environment (or Codex OAuth via `codex login`).
 */
export function codex(opts?: CodexPeerOptions): AcpPeerConfig {
  const sandbox = opts?.sandbox ?? false;
  const model = opts?.model ?? 'o3';

  const args = ['-y', '@zed-industries/codex-acp'];
  // Pass config overrides to the ACP adapter
  args.push('-c', `model="${model}"`);
  if (!sandbox) {
    args.push('-c', 'sandbox="danger-full-access"');
  }
  if (opts?.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return {
    name: opts?.name ?? 'codex',
    command: opts?.command ?? 'npx',
    args,
    env: opts?.env,
    description:
      opts?.description ?? 'Codex — OpenAI coding agent for delegated tasks',
  };
}

// ─── Claude Code ────────────────────────────────────────────────────

/** Options for the built-in Claude Code ACP peer. */
export interface ClaudeCodePeerOptions {
  /** Override the peer name. Default: "claude-code" */
  name?: string;
  /** Override the executable. Default: "npx" */
  command?: string;
  /** Extra CLI args appended after the built-in defaults. */
  extraArgs?: string[];
  /** Extra env vars merged with the built-in defaults. */
  env?: Record<string, string>;
  /** Description shown to the model. */
  description?: string;
  /** Anthropic model to use (alias or full ID). Default: "sonnet" */
  model?: string;
  /**
   * Whether Claude Code should run with its permission checks enabled.
   * Default: false — permissions are bypassed so the peer can operate
   * autonomously (file writes, git, shell, etc.).
   * Set to true to require interactive permission grants.
   */
  sandbox?: boolean;
}

/**
 * Create a Claude Code ACP peer config with sensible defaults.
 *
 * Out of the box:
 * - Permissions: bypassed (`--dangerously-skip-permissions`)
 * - Model: sonnet (latest Claude Sonnet)
 *
 * Requires `ANTHROPIC_API_KEY` in the environment.
 */
export function claudeCode(opts?: ClaudeCodePeerOptions): AcpPeerConfig {
  const sandbox = opts?.sandbox ?? false;
  const model = opts?.model ?? 'sonnet';

  const args = ['-y', '@agentclientprotocol/claude-agent-acp'];
  args.push('--model', model);
  if (!sandbox) {
    args.push('--dangerously-skip-permissions');
  }
  if (opts?.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return {
    name: opts?.name ?? 'claude-code',
    command: opts?.command ?? 'npx',
    args,
    env: opts?.env,
    description:
      opts?.description ??
      'Claude Code — Anthropic coding agent for delegated tasks',
  };
}
