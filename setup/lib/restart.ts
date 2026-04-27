/**
 * Centralised "restart the host" helper.
 *
 * Single source of truth for: which service mode is installed (read from
 * `logs/setup.log`), what command to issue per mode, and confirming the host
 * actually rebound its CLI socket afterwards. Replaces the hardcoded
 * `launchctl kickstart … || true` / `systemctl --user restart … || true` +
 * `sleep 5` blocks that lived in every `add-<channel>.sh` script and which
 * silently no-op'd on nohup installs.
 *
 * Bash callers go through `setup/lib/restart.sh` which execs `tsx` against
 * this module's `mainCli` so there's only one implementation.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';

import { waitForSocket } from './agent-ping.js';
import { lastStepFields } from '../logs.js';

export type ServiceMode =
  | 'launchd'
  | 'systemd-system'
  | 'systemd-user'
  | 'nohup'
  | 'unknown';

export type RestartResult = {
  ok: boolean;
  mode: ServiceMode;
  reason?: string;
};

/**
 * Read the most recent service step from `logs/setup.log` and return the
 * mode we last installed. Falls back to `'unknown'` if no service step has
 * run yet (or the log is missing).
 *
 * `cwd` defaults to the current working directory because every caller
 * runs from the project root.
 */
export function detectInstalledServiceMode(cwd: string = process.cwd()): ServiceMode {
  const originalCwd = process.cwd();
  if (cwd !== originalCwd) {
    try {
      process.chdir(cwd);
      return readModeFromLog();
    } finally {
      process.chdir(originalCwd);
    }
  }
  return readModeFromLog();
}

function readModeFromLog(): ServiceMode {
  const fields = lastStepFields('service');
  const t = fields?.service_type;
  if (t === 'launchd' || t === 'systemd-system' || t === 'systemd-user' || t === 'nohup') {
    return t;
  }
  return 'unknown';
}

/**
 * Restart the host service in whatever mode it was installed under, then
 * wait up to 10s for `data/cli.sock` to come back online. Returns
 * `{ ok: false }` if either the restart command failed or the socket never
 * reappeared.
 *
 * `mode` may be passed explicitly (skips the log lookup) — handy for the
 * service step itself, which knows which branch it just took.
 */
export async function restartService(
  projectRoot: string = process.cwd(),
  mode?: ServiceMode,
): Promise<RestartResult> {
  const resolved: ServiceMode = mode ?? detectInstalledServiceMode(projectRoot);
  const socketPath = path.join(projectRoot, 'data', 'cli.sock');
  let restartOk = false;
  let reason: string | undefined;

  try {
    switch (resolved) {
      case 'launchd': {
        const label = getLaunchdLabel(projectRoot);
        const uid = process.getuid?.() ?? 0;
        execSync(`launchctl kickstart -k gui/${uid}/${label}`, {
          stdio: 'pipe',
          timeout: 15_000,
        });
        restartOk = true;
        break;
      }
      case 'systemd-user': {
        const unit = getSystemdUnit(projectRoot);
        execSync(`systemctl --user restart ${unit}`, {
          stdio: 'pipe',
          timeout: 15_000,
        });
        restartOk = true;
        break;
      }
      case 'systemd-system': {
        const unit = getSystemdUnit(projectRoot);
        execSync(`sudo -n systemctl restart ${unit}`, {
          stdio: 'pipe',
          timeout: 15_000,
        });
        restartOk = true;
        break;
      }
      case 'nohup':
      case 'unknown': {
        // Either we're explicitly in nohup mode, or we have no idea what
        // was installed — try the wrapper if it exists. The wrapper itself
        // handles "stop existing PID, start fresh."
        const wrapper = path.join(projectRoot, 'start-nanoclaw.sh');
        if (!fs.existsSync(wrapper)) {
          return { ok: false, mode: resolved, reason: 'no_service_artifact' };
        }
        // Run detached so the parent (this tsx process) can exit while the
        // wrapper-spawned node host keeps running.
        const child = spawn('bash', [wrapper], {
          cwd: projectRoot,
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        // Give the wrapper itself a moment to exec the nohup line before
        // we start polling for the socket — the wrapper sleeps 2s if it
        // had to kill an existing PID first.
        await new Promise((r) => setTimeout(r, 250));
        restartOk = true;
        break;
      }
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  if (!restartOk) {
    return { ok: false, mode: resolved, reason };
  }

  const socketUp = await waitForSocket(socketPath, 10_000);
  if (!socketUp) {
    return { ok: false, mode: resolved, reason: 'socket_did_not_reappear' };
  }
  return { ok: true, mode: resolved };
}

/**
 * CLI entry — invoked by `setup/lib/restart.sh`. Exits 0 on success, 1
 * otherwise; emits a one-line `mode=<m> ok=<bool>[ reason=<r>]` summary on
 * stderr so the calling shell script can surface diagnostics.
 */
async function mainCli(): Promise<void> {
  const result = await restartService();
  const fragments = [`mode=${result.mode}`, `ok=${result.ok}`];
  if (result.reason) fragments.push(`reason=${result.reason}`);
  process.stderr.write(fragments.join(' ') + '\n');
  process.exit(result.ok ? 0 : 1);
}

// tsx invokes the file as the entry — `import.meta.url` and `process.argv[1]`
// resolve to this module when run directly. We compare basenames to dodge
// symlink/realpath drift on macOS where /tmp is a symlink to /private/tmp.
const invokedAsScript = (() => {
  try {
    const arg1 = process.argv[1] ?? '';
    return arg1.endsWith('restart.ts') || arg1.endsWith('restart.js');
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  mainCli().catch((err) => {
    process.stderr.write(`mode=unknown ok=false reason=${(err as Error).message}\n`);
    process.exit(1);
  });
}
