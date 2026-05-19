/**
 * Detect and clean up unhealthy NanoClaw peer services.
 *
 * Runs as a setup preflight before we install our own service. A crash-looping
 * peer install (typically the legacy v1 `com.nanoclaw` plist) silently trashes
 * this install's containers on every respawn because its `cleanupOrphans()`
 * reaps anything matching `nanoclaw-`. We scope our reaper by label now, but
 * we still need to stop the peer from killing us on its way down.
 *
 * A peer is "unhealthy" when:
 *   - launchd: `state != running` AND `runs > UNHEALTHY_RUNS_THRESHOLD`
 *   - systemd: unit is in `failed` state, OR `activating` with many restarts
 *
 * Healthy peers are left alone — multiple installs can coexist fine now that
 * container-reaper is label-scoped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { log } from '../src/log.js';

const UNHEALTHY_RUNS_THRESHOLD = 10;

export interface PeerStatus {
  label: string;
  configPath: string;
  state: string;
  runs: number;
  unhealthy: boolean;
}

export interface PeerCleanupResult {
  checked: PeerStatus[];
  unloaded: PeerStatus[];
  failures: Array<{ label: string; err: string }>;
}

/**
 * Scan for peer NanoClaw services and unload any that are crash-looping.
 * Returns a summary suitable for emitStatus / setup-log reporting.
 */
export function cleanupUnhealthyPeers(projectRoot: string = process.cwd()): PeerCleanupResult {
  const platform = os.platform();
  if (platform === 'darwin') {
    return cleanupLaunchdPeers(projectRoot);
  }
  if (platform === 'linux') {
    return cleanupSystemdPeers(projectRoot);
  }
  return { checked: [], unloaded: [], failures: [] };
}

// ---- launchd (macOS) --------------------------------------------------------

function cleanupLaunchdPeers(projectRoot: string): PeerCleanupResult {
  const ownLabel = getLaunchdLabel(projectRoot);
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const result: PeerCleanupResult = { checked: [], unloaded: [], failures: [] };

  let plists: string[];
  try {
    plists = fs
      .readdirSync(agentsDir)
      .filter((f) => /^com\.nanoclaw.*\.plist$/.test(f))
      .map((f) => path.join(agentsDir, f));
  } catch {
    return result;
  }

  const uid = process.getuid?.() ?? 0;

  for (const plistPath of plists) {
    const label = path.basename(plistPath, '.plist');
    if (label === ownLabel) continue;

    const status = probeLaunchdPeer(label, plistPath, uid);
    if (!status) continue;
    result.checked.push(status);

    if (!status.unhealthy) continue;

    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
      log.info('Unloaded unhealthy peer launchd service', {
        label,
        state: status.state,
        runs: status.runs,
        plistPath,
      });
      result.unloaded.push(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to unload peer launchd service', { label, err: message });
      result.failures.push({ label, err: message });
    }
  }

  return result;
}

function probeLaunchdPeer(label: string, plistPath: string, uid: number): PeerStatus | null {
  let output: string;
  try {
    output = execFileSync('launchctl', ['print', `gui/${uid}/${label}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch {
    // Not loaded → not currently a threat. Skip silently.
    return null;
  }

  const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(output)?.[1] ?? 'unknown';
  const runsStr = /^\s*runs\s*=\s*(\d+)/m.exec(output)?.[1];
  const runs = runsStr ? parseInt(runsStr, 10) : 0;

  const unhealthy = state !== 'running' && runs > UNHEALTHY_RUNS_THRESHOLD;
  return { label, configPath: plistPath, state, runs, unhealthy };
}

// ---- systemd (Linux) --------------------------------------------------------

function cleanupSystemdPeers(projectRoot: string): PeerCleanupResult {
  const ownUnit = getSystemdUnit(projectRoot);
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const result: PeerCleanupResult = { checked: [], unloaded: [], failures: [] };

  let units: string[];
  try {
    units = fs
      .readdirSync(unitDir)
      .filter((f) => /^nanoclaw.*\.service$/.test(f))
      .map((f) => f.replace(/\.service$/, ''));
  } catch {
    return result;
  }

  for (const unit of units) {
    if (unit === ownUnit) continue;

    const status = probeSystemdPeer(unit);
    if (!status) continue;
    result.checked.push(status);

    if (!status.unhealthy) continue;

    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${unit}.service`], { stdio: 'pipe' });
      log.info('Disabled unhealthy peer systemd unit', {
        unit,
        state: status.state,
        runs: status.runs,
      });
      result.unloaded.push(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to disable peer systemd unit', { unit, err: message });
      result.failures.push({ label: unit, err: message });
    }
  }

  return result;
}

function probeSystemdPeer(unit: string): PeerStatus | null {
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${unit}.service`);
  try {
    const output = execFileSync(
      'systemctl',
      ['--user', 'show', '--property=ActiveState,NRestarts', `${unit}.service`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const activeState = /^ActiveState=(.+)$/m.exec(output)?.[1]?.trim() ?? 'unknown';
    const restartsStr = /^NRestarts=(\d+)/m.exec(output)?.[1];
    const runs = restartsStr ? parseInt(restartsStr, 10) : 0;

    const unhealthy =
      activeState === 'failed' || (activeState !== 'active' && runs > UNHEALTHY_RUNS_THRESHOLD);
    return { label: unit, configPath: unitPath, state: activeState, runs, unhealthy };
  } catch {
    return null;
  }
}
