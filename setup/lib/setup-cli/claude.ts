/**
 * Claude Code adapter for the setup-helper registry.
 *
 * Headless: `claude -p --output-format text "<prompt>"` — print mode.
 * Handoff:  `claude "<prompt>"` — opens the interactive TUI with the
 * prompt as the opening message; user types `/exit` to return.
 *
 * Auth probe: `claude auth status` exits 0 when authed (any path —
 * subscription token, OAuth, API key — counts).
 */
import { execSync } from 'child_process';
import path from 'path';

import type { SpawnArgs, SetupCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  try {
    execSync('claude auth status', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function headless(prompt: string): SpawnArgs {
  return {
    args: ['-p', '--output-format', 'text', prompt],
    stdin: 'ignore',
    output: 'pipe',
  };
}

function handoff(prompt: string): SpawnArgs {
  return {
    args: [prompt],
    stdin: 'inherit',
    output: 'inherit',
  };
}

export const claudeCli: SetupCli = {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  isInstalled,
  isAuthenticated,
  installScript: path.join('setup', 'install-claude.sh'),
  headless,
  handoff,
};
