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
    'com.nanoclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
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
    serviceLoaded = output.includes('com.nanoclaw');
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
 * Prevents WhatsApp "conflict" disconnects when two instances connect simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned nanoclaw processes');
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
    unitPath = '/etc/systemd/system/nanoclaw.service';
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
    unitPath = path.join(unitDir, 'nanoclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  // Check if Litestream backup is configured
  const envPath = path.join(projectRoot, '.env');
  let litestreamEnabled = false;
  let gcsBucket = '';
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    litestreamEnabled = /^LITESTREAM_ENABLED=true$/m.test(envContent);
    const bucketMatch = envContent.match(/^GCS_BACKUP_BUCKET=(.+)$/m);
    if (bucketMatch) gcsBucket = bucketMatch[1].trim();
  }

  // Build After/Wants lines conditionally for Litestream
  const afterTargets = ['network.target'];
  const wantsTargets: string[] = [];
  const envLines = [
    `Environment=HOME=${homeDir}`,
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`,
  ];

  if (litestreamEnabled && !runningAsRoot) {
    afterTargets.push('litestream.service');
    wantsTargets.push('litestream.service');
    envLines.push('Environment=LITESTREAM_ENABLED=true');
    if (gcsBucket) {
      envLines.push(`Environment=GCS_BACKUP_BUCKET=${gcsBucket}`);
    }
  }

  const unit = `[Unit]
Description=NanoClaw Personal Assistant
After=${afterTargets.join(' ')}${wantsTargets.length > 0 ? `\nWants=${wantsTargets.join(' ')}` : ''}

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
${envLines.join('\n')}
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

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

  // Kill orphaned nanoclaw processes to avoid WhatsApp conflict errors
  killOrphanedProcesses(projectRoot);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  // Install Litestream units if backup is configured (user-level only)
  if (litestreamEnabled && !runningAsRoot) {
    installLitestreamUnits(projectRoot, homeDir, gcsBucket, systemctlPrefix);
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    ...(litestreamEnabled ? { LITESTREAM_ENABLED: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

/**
 * Install Litestream and rsync systemd units for GCS backup.
 * Generates per-tenant litestream.yml with the correct bucket name.
 */
function installLitestreamUnits(
  projectRoot: string,
  homeDir: string,
  gcsBucket: string,
  systemctlPrefix: string,
): void {
  const username = os.userInfo().username;
  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });

  // Validate bucket name before generating configs
  if (gcsBucket && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(gcsBucket)) {
    logger.error(
      { gcsBucket },
      'Invalid GCS_BACKUP_BUCKET name, skipping Litestream setup',
    );
    return;
  }

  // Enable linger so user-level services survive SSH disconnect
  try {
    execSync(`loginctl enable-linger ${JSON.stringify(username)}`, {
      stdio: 'ignore',
    });
    logger.info({ username }, 'Enabled loginctl linger');
  } catch {
    logger.warn('loginctl enable-linger failed (may need sudo)');
  }

  // Generate per-tenant litestream.yml
  const litestreamConfig = `dbs:
  - path: ${projectRoot}/store/messages.db
    replicas:
      - type: gcs
        bucket: ${gcsBucket}
        path: litestream/messages.db
        sync-interval: 10s
        snapshot-interval: 1h
`;
  const litestreamConfigPath = path.join(homeDir, '.config', 'litestream.yml');
  fs.writeFileSync(litestreamConfigPath, litestreamConfig);
  logger.info({ litestreamConfigPath }, 'Wrote Litestream config');

  // Copy service units from deploy/ to user systemd dir
  const deployDir = path.join(projectRoot, 'deploy');
  for (const unitFile of [
    'litestream.service',
    'nanoclaw-rsync.service',
    'nanoclaw-rsync.timer',
  ]) {
    const src = path.join(deployDir, unitFile);
    const dst = path.join(unitDir, unitFile);
    if (fs.existsSync(src)) {
      let content = fs.readFileSync(src, 'utf-8');
      // For rsync service, set the GCS_BACKUP_BUCKET environment
      if (unitFile === 'nanoclaw-rsync.service' && gcsBucket) {
        content = content.replace(
          /\[Service\]/,
          `[Service]\nEnvironment=GCS_BACKUP_BUCKET=${gcsBucket}`,
        );
      }
      fs.writeFileSync(dst, content);
      logger.info({ dst }, `Installed ${unitFile}`);
    } else {
      logger.warn({ src }, `Unit file not found, skipping ${unitFile}`);
    }
  }

  // Reload and enable units
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.warn({ err }, 'systemctl daemon-reload failed');
  }
  try {
    execSync(`${systemctlPrefix} enable litestream`, { stdio: 'ignore' });
    logger.info('Enabled litestream');
  } catch (err) {
    logger.warn({ err }, 'Failed to enable litestream');
  }
  try {
    execSync(`${systemctlPrefix} enable nanoclaw-rsync.timer`, {
      stdio: 'ignore',
    });
    logger.info('Enabled nanoclaw-rsync.timer');
  } catch (err) {
    logger.warn({ err }, 'Failed to enable nanoclaw-rsync.timer');
  }

  // Start Litestream (rsync timer starts on boot)
  try {
    execSync(`${systemctlPrefix} start litestream`, { stdio: 'ignore' });
    logger.info('Started litestream');
  } catch (err) {
    logger.warn({ err }, 'Failed to start litestream');
  }
  try {
    execSync(`${systemctlPrefix} start nanoclaw-rsync.timer`, {
      stdio: 'ignore',
    });
    logger.info('Started nanoclaw-rsync.timer');
  } catch (err) {
    logger.warn({ err }, 'Failed to start nanoclaw-rsync.timer');
  }
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

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
