/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { waitForSocket } from './lib/agent-ping.js';
import { ensureSudoCached } from './lib/sudo.js';
import { cleanupUnhealthyPeers } from './peer-cleanup.js';
import {
  commandExists,
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

/**
 * Reason linger was not enabled, surfaced into the SETUP_SERVICE status block
 * so the setup driver can render an accurate "to upgrade to systemd…" hint
 * when we fall back to the nohup wrapper.
 */
type LingerReason = 'no_sudo_for_loginctl' | 'loginctl_failed' | 'wsl';

const SOCKET_WAIT_MS = 10_000;

function socketPathFor(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'cli.sock');
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  log.info('Setting up service', { platform, nodePath, projectRoot });

  // Build first
  log.info('Building TypeScript');
  try {
    execSync('pnpm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.info('Build succeeded');
  } catch {
    log.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  // Peer preflight — a crash-looping peer install (most often the legacy v1
  // `com.nanoclaw` plist) will keep trashing this install's containers on
  // every respawn via its own cleanupOrphans. Detect and unload any peer
  // that's unhealthy before we install our service. Healthy peers are left
  // alone now that container reaping is install-label-scoped.
  const peerReport = cleanupUnhealthyPeers(projectRoot);
  if (peerReport.unloaded.length > 0) {
    log.warn('Unloaded unhealthy peer NanoClaw services', {
      count: peerReport.unloaded.length,
      labels: peerReport.unloaded.map((p) => p.label),
    });
  }

  if (platform === 'macos') {
    await setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    await setupLinux(projectRoot, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

async function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): Promise<void> {
  // Per-checkout service label so multiple NanoClaw installs can coexist
  // without clobbering each other's plist.
  const label = getLaunchdLabel(projectRoot);
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${label}.plist`,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  log.info('Wrote launchd plist', { plistPath });

  // Unload first to force launchd to drop any cached plist and re-read from
  // disk. Bare `launchctl load` on an already-loaded plist errors with
  // "already loaded" and keeps the ORIGINAL plist's ProgramArguments /
  // WorkingDirectory in memory — even if the file on disk changed. That
  // bit us when the plist target shifted between installs: kickstart kept
  // relaunching the old binary and the CLI socket landed in the wrong dir.
  // unload succeeds whether or not the service was previously loaded; the
  // failure case is "Could not find specified service" which is harmless.
  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    log.info('launchctl unload succeeded');
  } catch {
    log.info('launchctl unload noop (plist was not previously loaded)');
  }

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    log.info('launchctl load succeeded');
  } catch (err) {
    log.error('launchctl load failed', { err });
  }

  // Verify
  let listLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    listLoaded = output.includes(label);
  } catch {
    // launchctl list failed
  }

  // Self-ping: the service is "loaded" per launchctl as soon as the plist is
  // accepted, but that doesn't tell us the host actually bound its socket.
  // Wait for data/cli.sock so a crash-looping process surfaces here, not
  // three steps later at first-chat.
  const socketUp = await waitForSocket(socketPathFor(projectRoot), SOCKET_WAIT_MS);
  const status = listLoaded && socketUp ? 'success' : listLoaded ? 'degraded' : 'failed';

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    SERVICE_LABEL: label,
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: socketUp,
    STATUS: status,
    LOG: 'logs/setup.log',
  });
}

async function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): Promise<void> {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    await setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    await setupNohupFallback(projectRoot, nodePath, homeDir, 'wsl');
  }
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    log.info('Stopped any orphaned nanoclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

/**
 * Attempt to spawn the user-level systemd manager via `loginctl enable-linger`,
 * so the subsequent `systemctl --user daemon-reload` probe has something to
 * talk to. Without this, sessions that didn't go through PAM (`su -`, certain
 * LXC login paths) have no `systemd --user` running and the probe fails — at
 * which point we'd fall back to the nohup wrapper unnecessarily.
 *
 * Returns the actual outcome so the caller can stash it in the status block
 * if we still end up falling back.
 */
function tryEnableLinger(): { ok: true } | { ok: false; reason: LingerReason } {
  if (isWSL()) return { ok: false, reason: 'wsl' };
  const sudoState = ensureSudoCached();
  const user = execSync('whoami', { encoding: 'utf-8' }).trim();
  // Prefer sudo to avoid polkit's pkttyagent (often missing on minimal
  // boxes) which produces noise on the spinner. If no sudo cache, fall
  // through to direct loginctl — polkit may still grant the action.
  const cmd = sudoState === 'cached'
    ? `sudo -n loginctl enable-linger ${user}`
    : 'loginctl enable-linger';
  try {
    execSync(cmd, { stdio: 'ignore' });
    log.info('Enabled loginctl linger for current user', {
      via: sudoState === 'cached' ? 'sudo' : 'polkit',
    });
    return { ok: true };
  } catch (err) {
    const reason: LingerReason = sudoState === 'cached'
      ? 'loginctl_failed'
      : 'no_sudo_for_loginctl';
    log.warn('loginctl enable-linger failed — service may stop on SSH logout', {
      err,
      reason,
    });
    return { ok: false, reason };
  }
}

async function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): Promise<void> {
  const runningAsRoot = isRoot();
  const unitName = getSystemdUnit(projectRoot);
  const unitFileName = `${unitName}.service`;

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;
  let lingerOutcome: { ok: true } | { ok: false; reason: LingerReason } | null = null;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${unitFileName}`;
    systemctlPrefix = 'systemctl';
    log.info('Running as root — installing system-level systemd unit');
  } else {
    // Enable linger BEFORE probing systemctl --user. enable-linger talks to
    // the system-level systemd (PID 1) and spawns the user manager as a
    // side effect — so the subsequent probe succeeds even when the current
    // shell didn't go through a PAM session that would have started one
    // (`su -`, raw LXC console, some headless paths). Idempotent on
    // already-lingered users.
    lingerOutcome = tryEnableLinger();

    // Probe whether `systemctl --user` actually has a user manager to talk to.
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      const fallbackReason: LingerReason | undefined = lingerOutcome.ok
        ? undefined
        : lingerOutcome.reason;
      log.warn(
        'systemd user session not available — falling back to nohup wrapper',
        { lingerReason: fallbackReason },
      );
      await setupNohupFallback(projectRoot, nodePath, homeDir, fallbackReason);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, unitFileName);
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  log.info('Wrote systemd unit', { unitPath });

  // Detect stale docker group before starting (user systemd only). The user
  // systemd manager is a long-running process whose group list is frozen at
  // login, so `usermod -aG docker` mid-session doesn't reach it. Rather than
  // require the user to log out + back in, punch a POSIX ACL onto the socket
  // that grants the current user rw directly. This is temporary — the socket
  // is recreated by dockerd on restart (and by then the user has relogged, so
  // normal group perms apply again).
  let dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    log.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
    if (commandExists('setfacl')) {
      const user = execSync('whoami', { encoding: 'utf-8' }).trim();
      // `sudo -n` (non-interactive) — child stdio is piped to the parent
      // spinner, so an interactive prompt would be invisible AND read from
      // /dev/null forever. Fail fast if the cache expired and let auto.ts
      // surface the manual workaround via DOCKER_GROUP_STALE.
      const sudoState = ensureSudoCached();
      if (sudoState === 'cached') {
        try {
          execSync(`sudo -n setfacl -m u:${user}:rw /var/run/docker.sock`, {
            stdio: 'pipe',
          });
          log.info(
            'Applied temporary ACL to /var/run/docker.sock (resets on docker restart or reboot)',
          );
          dockerGroupStale = false;
        } catch (err) {
          log.warn('Failed to apply setfacl workaround', { err });
        }
      } else {
        log.warn('Sudo cache not available for setfacl workaround', { sudoState });
      }
    } else {
      log.warn('setfacl not installed — cannot apply automatic workaround');
    }
  }

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl daemon-reload failed', { err });
  }

  try {
    execSync(`${systemctlPrefix} enable ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl enable failed', { err });
  }

  // restart (not start) so a previously-running instance picks up edits to
  // the unit file. `start` on an active unit is a no-op, which would leave
  // the old ExecStart / WorkingDirectory in effect even after daemon-reload.
  // `restart` on a stopped unit is equivalent to `start`, so this is safe
  // as a first-install path too.
  try {
    execSync(`${systemctlPrefix} restart ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl restart failed', { err });
  }

  // Verify: is-active confirms systemd thinks the unit is up; the socket
  // wait confirms the host actually bound. Both must hold for "success".
  let isActive = false;
  try {
    execSync(`${systemctlPrefix} is-active ${unitName}`, { stdio: 'ignore' });
    isActive = true;
  } catch {
    // Not active
  }
  const socketUp = await waitForSocket(socketPathFor(projectRoot), SOCKET_WAIT_MS);
  const status = isActive && socketUp ? 'success' : isActive ? 'degraded' : 'failed';

  const lingerEnabled = runningAsRoot ? false : lingerOutcome?.ok === true;

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    SERVICE_UNIT: unitName,
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: socketUp,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    LINGER_ENABLED: lingerEnabled,
    STATUS: status,
    LOG: 'logs/setup.log',
  });
}

async function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  lingerReason?: LingerReason,
): Promise<void> {
  log.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');

  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh — Start NanoClaw without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting NanoClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/nanoclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "NanoClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/nanoclaw.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  log.info('Wrote nohup wrapper script', { wrapperPath });

  // Don't leave a previous nohup-installed host running with stale code —
  // its pid lives in nanoclaw.pid and the wrapper handles the kill, but
  // pkill picks up debugger-spawned processes too.
  killOrphanedProcesses(projectRoot);

  // Actually run the wrapper. Earlier revisions wrote the script and exited
  // success without ever starting the host — so the next setup step (first
  // chat) failed against a service that had never started. The wrapper
  // backgrounds via `nohup &` so this exec returns in ~1s; the detached node
  // child outlives this tsx process via the SIGHUP-immune nohup invocation.
  let wrapperExecOk = false;
  try {
    execSync(`bash ${JSON.stringify(wrapperPath)}`, {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 15_000,
    });
    wrapperExecOk = true;
    log.info('Started NanoClaw via nohup wrapper');
  } catch (err) {
    log.error('Failed to execute start-nanoclaw.sh', { err });
  }

  const socketUp = wrapperExecOk
    ? await waitForSocket(socketPathFor(projectRoot), SOCKET_WAIT_MS)
    : false;
  const status = !wrapperExecOk
    ? 'failed'
    : socketUp
      ? 'success'
      : 'degraded';

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: socketUp,
    FALLBACK: 'wsl_no_systemd',
    ...(lingerReason ? { LINGER_REASON: lingerReason } : {}),
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') {
    process.exit(1);
  }
}
