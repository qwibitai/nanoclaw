/**
 * Setup-helper agent registry barrel.
 *
 * The setup flow can hand off failed steps to a coding-agent CLI for
 * interactive debugging or call one headlessly for utility tasks
 * (e.g. timezone parsing). Each supported CLI is one adapter file
 * exporting a `SetupCli`. This barrel collects them and
 * exposes selection helpers.
 *
 * Selection precedence:
 *   1. `NANOCLAW_SETUP_CLI` env var (if set + adapter exists)
 *   2. Caller's explicit choice (passed to `getSetupCli(name)`)
 *   3. Auto-pick: first registered adapter that's installed
 *
 * Adding a new CLI:
 *   1. Create `setup/lib/setup-cli/<name>.ts` exporting a
 *      `SetupCli`-conformant const.
 *   2. Append it to `BUILTIN_CLIS` below.
 *   3. The setup-time picker shows it automatically.
 */
import { readEnvFile } from '../../../src/env.js';
import { claudeCli } from './claude.js';
import { codexCli } from './codex.js';
import type { SetupCli } from './types.js';

const BUILTIN_CLIS: SetupCli[] = [claudeCli, codexCli];

const registry = new Map<string, SetupCli>();
for (const cli of BUILTIN_CLIS) {
  registry.set(cli.name, cli);
}

export function listSetupClis(): SetupCli[] {
  return [...registry.values()];
}

export function getSetupCli(name: string | null | undefined): SetupCli | undefined {
  if (!name) return undefined;
  return registry.get(name.toLowerCase());
}

/**
 * Resolve the agent to use, in this priority order:
 *   1. `NANOCLAW_SETUP_CLI` from `.env` or `process.env`
 *   2. The first installed adapter, in registration order (`claude` first)
 *   3. `null` if nothing works — caller decides whether to error or skip
 */
export function resolveSetupCli(): SetupCli | null {
  const env = readEnvFile(['NANOCLAW_SETUP_CLI']);
  const configured = process.env.NANOCLAW_SETUP_CLI || env.NANOCLAW_SETUP_CLI;
  if (configured) {
    const a = registry.get(configured.toLowerCase());
    if (a && a.isInstalled()) return a;
    // Configured but missing — fall through to auto-detect rather than
    // hard-failing; the caller can warn separately.
  }
  for (const cli of BUILTIN_CLIS) {
    if (adapter.isInstalled()) return cli;
  }
  return null;
}

/** Test helper. */
export function _resetRegistryForTest(): void {
  registry.clear();
  for (const cli of BUILTIN_CLIS) {
    registry.set(cli.name, cli);
  }
}

export type { SpawnArgs, SetupCli } from './types.js';
export { claudeCli, codexCli };
