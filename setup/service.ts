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

/**
 * Detect extra PATH directories and environment variables needed by channels.
 * Channels write their requirements to store/service-env.json during setup.
 * This function also auto-detects common requirements (Homebrew, Java).
 */
function detectServiceEnv(projectRoot: string): Record<string, string> {
  const env: Record<string, string> = {};

  // Auto-detect Homebrew (macOS) — many channel dependencies install here
  // /opt/homebrew/bin = Apple Silicon, /usr/local/bin = Intel (already in basePath)
  if (fs.existsSync('/opt/homebrew/bin')) {
    env.__EXTRA_PATH_DIRS = '/opt/homebrew/bin';
  }

  // Auto-detect Java (needed by signal-cli, possibly others)
  // Prefer Homebrew Java over system Java — Homebrew is typically newer
  const javaCandidates = [
    '/opt/homebrew/opt/openjdk/bin/java',   // macOS Apple Silicon Homebrew
    '/usr/local/opt/openjdk/bin/java',      // macOS Intel Homebrew
    'java',                                  // System PATH fallback
  ];
  for (const javaCmd of javaCandidates) {
    try {
      if (javaCmd !== 'java' && !fs.existsSync(javaCmd)) continue;
      const javaOutput = execSync(
        `${javaCmd} -XshowSettings:properties -version 2>&1`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      const match = javaOutput.match(/java\.home\s*=\s*(.+)/);
      if (match) {
        env.JAVA_HOME = match[1].trim();
        const javaBin = path.dirname(javaCmd === 'java' ? path.join(env.JAVA_HOME, 'bin', 'java') : javaCmd);
        env.__EXTRA_PATH_DIRS = env.__EXTRA_PATH_DIRS
          ? `${env.__EXTRA_PATH_DIRS}:${javaBin}`
          : javaBin;
        logger.info({ JAVA_HOME: env.JAVA_HOME, javaBin }, 'Detected Java');
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  // Read channel-declared env vars (channels write these during their setup)
  const envFile = path.join(projectRoot, 'store', 'service-env.json');
  if (fs.existsSync(envFile)) {
    try {
      const channelEnv = JSON.parse(
        fs.readFileSync(envFile, 'utf-8'),
      ) as Record<string, string>;
      for (const [k, v] of Object.entries(channelEnv)) {
        if (typeof v === 'string') env[k] = v;
      }
      logger.info(
        { keys: Object.keys(channelEnv) },
        'Loaded channel service env vars',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to parse store/service-env.json');
    }
  }

  return env;
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

  const serviceEnv = detectServiceEnv(projectRoot);

  // Build PATH: detected extras + standard dirs
  const extraPaths = serviceEnv.__EXTRA_PATH_DIRS || '';
  delete serviceEnv.__EXTRA_PATH_DIRS;
  const basePath = `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`;
  const fullPath = extraPaths ? `${extraPaths}:${basePath}` : basePath;

  // Build extra env var XML entries
  const extraEnvXml = Object.entries(serviceEnv)
    .filter(([k]) => k !== 'PATH' && k !== 'HOME')
    .map(
      ([k, v]) =>
        `        <key>${k}</key>\n        <string>${v}</string>`,
    )
    .join('\n');

  const envBlock = [
    `        <key>PATH</key>`,
    `        <string>${fullPath}</string>`,
    extraEnvXml,
    `        <key>HOME</key>`,
    `        <string>${homeDir}</string>`,
  ]
    .filter(Boolean)
    .join('\n');

  // Use bash wrapper to avoid launchd issues on external/network volumes:
  //   1. WorkingDirectory fails silently with EX_CONFIG (exit 78)
  //   2. StandardOutPath/StandardErrorPath fail — launchd opens them before
  //      the process starts and can't access external volumes at that point
  //   3. Shell redirects (>>) from within the bash command also fail for the
  //      same volume-access reason
  // Solution: log to a local tmpdir, then symlink project logs/ to it.
  const logDir = path.join(homeDir, '.local', 'share', 'nanoclaw', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  // Symlink project logs/ → local log dir so `tail -f logs/nanoclaw.log` works
  const projectLogDir = path.join(projectRoot, 'logs');
  try {
    const existing = fs.lstatSync(projectLogDir);
    if (existing.isSymbolicLink()) {
      // Already a symlink — update if target changed
      if (fs.readlinkSync(projectLogDir) !== logDir) {
        fs.unlinkSync(projectLogDir);
        fs.symlinkSync(logDir, projectLogDir);
      }
    } else if (existing.isDirectory()) {
      // Move existing log files to new location, replace dir with symlink
      const files = fs.readdirSync(projectLogDir);
      for (const f of files) {
        const src = path.join(projectLogDir, f);
        const dst = path.join(logDir, f);
        try {
          if (!fs.existsSync(dst)) fs.renameSync(src, dst);
          else fs.unlinkSync(src);
        } catch { /* best effort */ }
      }
      fs.rmSync(projectLogDir, { recursive: true, force: true });
      fs.symlinkSync(logDir, projectLogDir);
    }
  } catch {
    // logs/ doesn't exist yet — create symlink
    fs.symlinkSync(logDir, projectLogDir);
  }
  logger.info({ logDir, symlink: projectLogDir }, 'Log directory configured');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd ${projectRoot} &amp;&amp; exec ${nodePath} dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
${envBlock}
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/nanoclaw.error.log</string>
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
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
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

  const serviceEnv = detectServiceEnv(projectRoot);
  const extraPaths = serviceEnv.__EXTRA_PATH_DIRS || '';
  delete serviceEnv.__EXTRA_PATH_DIRS;
  const basePath = `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`;
  const fullPath = extraPaths ? `${extraPaths}:${basePath}` : basePath;

  const envLines = [`Environment=HOME=${homeDir}`, `Environment=PATH=${fullPath}`];
  for (const [k, v] of Object.entries(serviceEnv)) {
    if (k !== 'PATH' && k !== 'HOME') {
      envLines.push(`Environment=${k}=${v}`);
    }
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

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
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
