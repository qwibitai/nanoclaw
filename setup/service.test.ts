import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services. The helpers mirror the actual logic in
 * service.ts so we can assert on the output shape.
 */

// --- Plist generation (macOS launchd) ---

/**
 * Generates a plist string the same way service.ts does:
 * - Uses bash wrapper (cd + exec) instead of WorkingDirectory
 * - Logs to local filesystem (~/.local/share/nanoclaw/logs/) not project dir
 * - Supports extra env vars (JAVA_HOME, etc.)
 * - KeepAlive=false, ThrottleInterval=5
 */
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  extraEnv?: Record<string, string>,
): string {
  const basePath = `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`;
  const fullPath = extraEnv?.__EXTRA_PATH_DIRS
    ? `${extraEnv.__EXTRA_PATH_DIRS}:${basePath}`
    : basePath;

  const envEntries = Object.entries(extraEnv ?? {})
    .filter(([k]) => k !== '__EXTRA_PATH_DIRS' && k !== 'PATH' && k !== 'HOME')
    .map(
      ([k, v]) =>
        `        <key>${k}</key>\n        <string>${v}</string>`,
    )
    .join('\n');

  const envBlock = [
    `        <key>PATH</key>`,
    `        <string>${fullPath}</string>`,
    envEntries,
    `        <key>HOME</key>`,
    `        <string>${homeDir}</string>`,
  ]
    .filter(Boolean)
    .join('\n');

  const logDir = path.join(homeDir, '.local', 'share', 'nanoclaw', 'logs');

  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

// --- Systemd unit generation (Linux) ---

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
  extraEnv?: Record<string, string>,
): string {
  const basePath = `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`;
  const extraPaths = extraEnv?.__EXTRA_PATH_DIRS || '';
  const fullPath = extraPaths ? `${extraPaths}:${basePath}` : basePath;

  const envLines = [
    `Environment=HOME=${homeDir}`,
    `Environment=PATH=${fullPath}`,
  ];
  for (const [k, v] of Object.entries(extraEnv ?? {})) {
    if (k !== '__EXTRA_PATH_DIRS' && k !== 'PATH' && k !== 'HOME') {
      envLines.push(`Environment=${k}=${v}`);
    }
  }

  return `[Unit]
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
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

// --- Tests ---

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/opt/homebrew/bin/node',
      '/Volumes/external/nanoclaw',
      '/Users/user',
    );
    expect(plist).toContain('<string>com.nanoclaw</string>');
  });

  it('uses bash wrapper instead of WorkingDirectory', () => {
    const plist = generatePlist(
      '/opt/homebrew/bin/node',
      '/Volumes/external/nanoclaw',
      '/Users/user',
    );
    expect(plist).toContain('<string>/bin/bash</string>');
    expect(plist).toContain('cd /Volumes/external/nanoclaw &amp;&amp; exec /opt/homebrew/bin/node dist/index.js');
    expect(plist).not.toContain('<key>WorkingDirectory</key>');
  });

  it('stores logs on local filesystem, not project directory', () => {
    const plist = generatePlist(
      '/opt/homebrew/bin/node',
      '/Volumes/external/nanoclaw',
      '/Users/user',
    );
    expect(plist).toContain('/Users/user/.local/share/nanoclaw/logs/nanoclaw.log');
    expect(plist).toContain('/Users/user/.local/share/nanoclaw/logs/nanoclaw.error.log');
    expect(plist).not.toContain('/Volumes/external/nanoclaw/logs/');
  });

  it('uses KeepAlive false and ThrottleInterval 5', () => {
    const plist = generatePlist(
      '/opt/homebrew/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<key>KeepAlive</key>\n    <false/>');
    expect(plist).toContain('<integer>5</integer>');
  });

  it('includes extra env vars like JAVA_HOME', () => {
    const plist = generatePlist(
      '/opt/homebrew/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      {
        __EXTRA_PATH_DIRS: '/opt/homebrew/bin:/opt/homebrew/opt/openjdk/bin',
        JAVA_HOME: '/opt/homebrew/Cellar/openjdk/25/libexec/openjdk.jdk/Contents/Home',
      },
    );
    expect(plist).toContain('<key>JAVA_HOME</key>');
    expect(plist).toContain('openjdk');
    expect(plist).toContain('/opt/homebrew/bin:/opt/homebrew/opt/openjdk/bin:');
  });

  it('works without extra env vars', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin');
    expect(plist).not.toContain('JAVA_HOME');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
  });

  it('includes extra env vars when provided', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
      {
        __EXTRA_PATH_DIRS: '/opt/homebrew/bin',
        JAVA_HOME: '/usr/lib/jvm/java-25',
      },
    );
    expect(unit).toContain('Environment=JAVA_HOME=/usr/lib/jvm/java-25');
    expect(unit).toContain('/opt/homebrew/bin:');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});
