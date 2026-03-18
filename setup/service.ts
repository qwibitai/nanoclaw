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

import { INSTANCE_ID } from '../src/config.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

// Instance-aware naming: nanoclaw → nanoclaw-staging
const SERVICE_NAME = INSTANCE_ID ? `nanoclaw-${INSTANCE_ID}` : 'nanoclaw';
const PLIST_LABEL = INSTANCE_ID
  ? `com.nanoclaw.${INSTANCE_ID}`
  : 'com.nanoclaw';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  logger.info({ platform, nodePath, projectRoot }, 'Setting up service');

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
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

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir);
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

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${PLIST_LABEL}.plist`,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
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
    <string>${projectRoot}/logs/${SERVICE_NAME}.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/${SERVICE_NAME}.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch {
    logger.warn('launchctl load failed (may already be loaded)');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(PLIST_LABEL);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, nodePath, homeDir);
  }
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 * Instance-aware: only kills processes matching the current instance to avoid
 * disrupting other running instances (e.g. staging setup won't kill production).
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    // Build a pattern that matches the specific instance.
    // For production (no INSTANCE_ID): match index.js but exclude any with NANOCLAW_INSTANCE set.
    // For named instances: match processes that have NANOCLAW_INSTANCE={id} in their env.
    if (INSTANCE_ID) {
      // Kill only processes with this specific instance ID in their environment
      execSync(
        `pgrep -f '${projectRoot}/dist/index\\.js' | xargs -r -I{} sh -c 'grep -qz "NANOCLAW_INSTANCE=${INSTANCE_ID}" /proc/{}/environ 2>/dev/null && kill {}' || true`,
        { stdio: 'ignore' },
      );
    } else {
      // Kill processes that do NOT have NANOCLAW_INSTANCE set (production only)
      execSync(
        `pgrep -f '${projectRoot}/dist/index\\.js' | xargs -r -I{} sh -c '! grep -qz "NANOCLAW_INSTANCE=" /proc/{}/environ 2>/dev/null && kill {}' || true`,
        { stdio: 'ignore' },
      );
    }
    logger.info(
      { instance: INSTANCE_ID || 'production' },
      'Stopped any orphaned nanoclaw processes',
    );
  } catch {
    // pgrep/xargs not available or no orphans
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

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${SERVICE_NAME}.service`;
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, `${SERVICE_NAME}.service`);
    systemctlPrefix = 'systemctl --user';
  }

  const instanceEnvLine = INSTANCE_ID
    ? `\nEnvironment=NANOCLAW_INSTANCE=${INSTANCE_ID}`
    : '';

  const unit = `[Unit]
Description=NanoClaw Personal Assistant${INSTANCE_ID ? ` (${INSTANCE_ID})` : ''}
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin${instanceEnvLine}
StandardOutput=append:${projectRoot}/logs/${SERVICE_NAME}.log
StandardError=append:${projectRoot}/logs/${SERVICE_NAME}.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  // Detect stale docker group before starting (user systemd only)
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ${SERVICE_NAME}`, {
      stdio: 'ignore',
    });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, `start-${SERVICE_NAME}.sh`);
  const pidFile = path.join(projectRoot, `${SERVICE_NAME}.pid`);

  const lines = [
    '#!/bin/bash',
    `# start-${SERVICE_NAME}.sh — Start NanoClaw${INSTANCE_ID ? ` (${INSTANCE_ID})` : ''} without systemd`,
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
    `echo "Starting NanoClaw${INSTANCE_ID ? ` (${INSTANCE_ID})` : ''}..."`,
    ...(INSTANCE_ID
      ? [`export NANOCLAW_INSTANCE=${JSON.stringify(INSTANCE_ID)}`]
      : []),
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + `/logs/${SERVICE_NAME}.log`)} \\`,
    `  2>> ${JSON.stringify(projectRoot + `/logs/${SERVICE_NAME}.error.log`)} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    `echo "NanoClaw${INSTANCE_ID ? ` (${INSTANCE_ID})` : ''} started (PID $!)"`,
    `echo "Logs: tail -f ${projectRoot}/logs/${SERVICE_NAME}.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
