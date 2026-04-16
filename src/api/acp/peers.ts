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
 * (sandbox disabled).
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
  /**
   * Whether Codex should run with its built-in sandbox enabled.
   * Default: false — sandbox is set to `full-access` so git,
   * file writes, and shell commands work out of the box.
   * Set to true to keep Codex's default sandbox restrictions.
   */
  sandbox?: boolean;
}

/**
 * Create a Codex ACP peer config with sensible defaults.
 *
 * Out of the box:
 * - Sandbox: `danger-full-access` (full filesystem + shell, no .git restriction)
 *
 * Model selection is left to Codex's own config / CLI defaults.
 * Pass `extraArgs: ['-c', 'model="o3"']` to override.
 *
 * Requires `OPENAI_API_KEY` in the environment (or Codex OAuth via `codex login`).
 */
export function codex(opts?: CodexPeerOptions): AcpPeerConfig {
  const sandbox = opts?.sandbox ?? false;

  const args = ['-y', '@zed-industries/codex-acp'];
  if (!sandbox) {
    args.push('-c', 'sandbox_mode="danger-full-access"');
    args.push('-c', 'approval_policy="never"');
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
 *
 * Model selection is left to Claude Code's own config / CLI defaults.
 * Pass `extraArgs: ['--model', 'opus']` to override.
 *
 * Requires `ANTHROPIC_API_KEY` in the environment.
 */
export function claudeCode(opts?: ClaudeCodePeerOptions): AcpPeerConfig {
  const sandbox = opts?.sandbox ?? false;

  const args = ['-y', '@agentclientprotocol/claude-agent-acp'];
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
