/**
 * Setup-helper agent adapter contract.
 *
 * The setup flow shells out to a coding-agent CLI for two things:
 *   1. Headless one-shot prompts (e.g. "what IANA timezone is `NYC`?")
 *   2. Interactive handoff when a step fails (operator debugs with full
 *      terminal control, then `/exit`s to return to setup)
 *
 * Each supported CLI (Claude Code, OpenAI Codex, future ones) is one
 * adapter file under `setup/lib/setup-cli/<name>.ts`. The registry
 * (in `./index.ts`) lets setup ask the user which CLI to use, persist
 * the choice, and dispatch the actual spawn.
 *
 * Adapters are inherently CLI-aware (every binary, flag set, install
 * path is different). The framework's job is to keep that specificity
 * contained.
 */

export interface SpawnArgs {
  /** Argv array (without the binary itself). */
  args: string[];
  /** Whether stdin should be inherited (handoff) or ignored (headless). */
  stdin: 'inherit' | 'ignore';
  /** Whether stdout/stderr should be captured (headless) or inherited (handoff). */
  output: 'inherit' | 'pipe';
}

export interface SetupCli {
  /** Stable identifier — used in `.env` (`NANOCLAW_SETUP_CLI=<name>`). */
  name: string;
  /** Human-readable name shown in prompts ("Claude Code", "OpenAI Codex"). */
  displayName: string;
  /** Binary on PATH (e.g. `claude`, `codex`). */
  binary: string;

  /** True if the binary is on PATH. */
  isInstalled(): boolean;

  /**
   * Best-effort auth check. Returns `true` if the CLI looks ready to
   * spawn requests, `false` if not, `undefined` if the CLI doesn't
   * expose a check we can probe quickly. Setup will tolerate `undefined`
   * (proceed and let the CLI error if it's actually broken).
   */
  isAuthenticated(): boolean | undefined;

  /**
   * Path to a bash installer script (e.g. `setup/install-claude.sh`).
   * `null` if this CLI has no scriptable installer (the user has to
   * install it manually before re-running setup).
   */
  installScript: string | null;

  /**
   * Build the argv for a non-interactive ("print mode") invocation that
   * sends `prompt` and reads the agent's reply from stdout. Used by
   * headless helpers like timezone resolution.
   */
  headless(prompt: string): SpawnArgs;

  /**
   * Build the argv for an interactive handoff. The user takes over the
   * terminal; the agent inherits stdin/stdout. The prompt is passed as
   * an opening message; the agent then runs interactively.
   */
  handoff(prompt: string): SpawnArgs;
}
