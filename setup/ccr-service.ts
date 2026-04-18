/**
 * Step: ccr — Install and start the Claude Code Router service.
 *
 * Installs a systemd unit (Linux) or launchd plist (macOS) for CCR,
 * so it runs persistently and starts before NanoClaw.
 * Also patches the NanoClaw service unit to depend on CCR.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import {
  getPlatform,
  getServiceManager,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

function getCcrPath(): string {
  try {
    return execSync('command -v ccr', { encoding: 'utf-8' }).trim();
  } catch {
    return 'ccr';
  }
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const platform = getPlatform();

  logger.info({ platform }, 'Setting up CCR service');

  if (platform === 'macos') {
    setupLaunchd(projectRoot, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, homeDir);
  } else {
    emitStatus('SETUP_CCR', {
      SERVICE_TYPE: 'unknown',
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
    });
    process.exit(1);
  }
}

function setupLaunchd(projectRoot: string, homeDir: string): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'ccr.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const ccrPath = getCcrPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ccr</string>
    <key>ProgramArguments</key>
    <array>
        <string>${ccrPath}</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/ccr.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/ccr.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist for CCR');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('CCR launchd load succeeded');
  } catch {
    logger.warn('CCR launchd load failed (may already be loaded)');
  }

  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('ccr');
  } catch {
    // launchctl list failed
  }

  patchNanoclawLaunchdService(homeDir);

  emitStatus('SETUP_CCR', {
    SERVICE_TYPE: 'launchd',
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
  });
}

function setupLinux(projectRoot: string, homeDir: string): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, homeDir);
  } else {
    setupNohupFallback(projectRoot, homeDir);
  }
}

function setupSystemd(projectRoot: string, homeDir: string): void {
  const runningAsRoot = isRoot();

  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/ccr.service';
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level CCR systemd unit');
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'ccr.service');
    systemctlPrefix = 'systemctl --user';
  }

  const ccrPath = getCcrPath();
  const ccrBinDir = path.dirname(ccrPath);

  const unit = `[Unit]
Description=Claude Code Router
After=network.target

[Service]
Type=simple
ExecStart=${ccrPath} start
Restart=always
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
Environment=HOME=${homeDir}
Environment=PATH=${ccrBinDir}:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
EnvironmentFile=${projectRoot}/.env
StandardOutput=append:${projectRoot}/logs/ccr.log
StandardError=append:${projectRoot}/logs/ccr.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote CCR systemd unit');

  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable ccr`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start ccr`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Patch nanoclaw.service to depend on ccr.service
  patchNanoclawSystemdService(systemctlPrefix);

  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ccr`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_CCR', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
  });
}

function setupNohupFallback(projectRoot: string, homeDir: string): void {
  logger.warn('No systemd detected — generating nohup wrapper for CCR');

  const ccrPath = getCcrPath();
  const wrapperPath = path.join(projectRoot, 'start-ccr.sh');
  const pidFile = path.join(projectRoot, 'ccr.pid');

  const lines = [
    '#!/bin/bash',
    '# start-ccr.sh — Start Claude Code Router without systemd',
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
    '    echo "Stopping existing CCR (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting Claude Code Router..."',
    `nohup exec ${ccrPath} start \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/ccr.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/ccr.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "CCR started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/ccr.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper for CCR');

  patchNanoclawNohupWrapper(projectRoot);

  emitStatus('SETUP_CCR', {
    SERVICE_TYPE: 'nohup',
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
  });
}

function patchNanoclawSystemdService(systemctlPrefix: string): void {
  try {
    const unitPath = execSync(`${systemctlPrefix} cat nanoclaw | grep '^# /' | cut -d' ' -f2`, { encoding: 'utf-8' }).trim();
    if (!unitPath || !fs.existsSync(unitPath)) return;

    let content = fs.readFileSync(unitPath, 'utf-8');

    if (content.includes('ccr.service')) {
      logger.info('nanoclaw service already depends on ccr.service');
      return;
    }

    // Add After=ccr.service and Wants=ccr.service to the [Unit] section
    content = content.replace(
      '[Unit]',
      '[Unit]\nAfter=ccr.service\nWants=ccr.service'
    );

    fs.writeFileSync(unitPath, content);
    logger.info({ unitPath }, 'Patched nanoclaw.service to depend on ccr.service');

    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.warn({ err }, 'Failed to patch nanoclaw.service to depend on ccr.service');
  }
}

function patchNanoclawLaunchdService(homeDir: string): void {
  try {
    const plistPath = path.join(
      homeDir,
      'Library',
      'LaunchAgents',
      'com.nanoclaw.plist'
    );

    if (!fs.existsSync(plistPath)) return;

    // Nothing really to "patch" for launchd to declare dependencies easily,
    // but we can just make sure `ccr` was loaded by launchctl, which we just did in `setupLaunchd`.
    // The OS will restart whichever service crashes.
    logger.info('launchd handles ccr automatically via KeepAlive');
  } catch (err) {
    logger.warn({ err }, 'Failed to read nanoclaw plist');
  }
}

function patchNanoclawNohupWrapper(projectRoot: string): void {
  try {
    const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
    if (!fs.existsSync(wrapperPath)) return;

    let content = fs.readFileSync(wrapperPath, 'utf-8');

    if (content.includes('start-ccr.sh')) {
      logger.info('start-nanoclaw.sh already starts CCR');
      return;
    }

    content = content.replace(
      'echo "Starting NanoClaw..."',
      `bash ${JSON.stringify(path.join(projectRoot, 'start-ccr.sh'))}\n` +
      'echo "Starting NanoClaw..."'
    );

    fs.writeFileSync(wrapperPath, content);
    logger.info({ wrapperPath }, 'Patched start-nanoclaw.sh to start CCR');
  } catch (err) {
    logger.warn({ err }, 'Failed to patch start-nanoclaw.sh to start CCR');
  }
}
