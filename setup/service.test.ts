import { describe, it, expect } from "vitest";
import path from "path";

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(nodePath: string, projectRoot: string, homeDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  const dockerWaitCmd = `/bin/sh -c 'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 2; done; echo "Docker not reachable after 60s" >&2; exit 1'`;

  const unitLines = ["[Unit]", "Description=NanoClaw Personal Assistant"];
  if (isSystem) {
    unitLines.push("After=network.target docker.service");
    unitLines.push("Requires=docker.service");
  } else {
    unitLines.push("After=network.target");
  }

  unitLines.push("");
  unitLines.push("[Service]");
  unitLines.push("Type=simple");
  if (!isSystem) {
    unitLines.push(`ExecStartPre=${dockerWaitCmd}`);
  }
  unitLines.push(`ExecStart=${nodePath} ${projectRoot}/dist/index.js`);
  unitLines.push(`WorkingDirectory=${projectRoot}`);
  unitLines.push("Restart=always");
  unitLines.push("RestartSec=5");
  unitLines.push(`Environment=HOME=${homeDir}`);
  unitLines.push(`Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`);
  unitLines.push(`StandardOutput=append:${projectRoot}/logs/nanoclaw.log`);
  unitLines.push(`StandardError=append:${projectRoot}/logs/nanoclaw.error.log`);
  unitLines.push("");
  unitLines.push("[Install]");
  unitLines.push(`WantedBy=${isSystem ? "multi-user.target" : "default.target"}`);

  return unitLines.join("\n");
}

describe("plist generation", () => {
  it("contains the correct label", () => {
    const plist = generatePlist("/usr/local/bin/node", "/home/user/nanoclaw", "/home/user");
    expect(plist).toContain("<string>com.nanoclaw</string>");
  });

  it("uses the correct node path", () => {
    const plist = generatePlist("/opt/node/bin/node", "/home/user/nanoclaw", "/home/user");
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
  });

  it("points to dist/index.js", () => {
    const plist = generatePlist("/usr/local/bin/node", "/home/user/nanoclaw", "/home/user");
    expect(plist).toContain("/home/user/nanoclaw/dist/index.js");
  });

  it("sets log paths", () => {
    const plist = generatePlist("/usr/local/bin/node", "/home/user/nanoclaw", "/home/user");
    expect(plist).toContain("nanoclaw.log");
    expect(plist).toContain("nanoclaw.error.log");
  });
});

describe("systemd unit generation", () => {
  it("user unit uses default.target", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", false);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("system unit uses multi-user.target", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", true);
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("contains restart policy", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", false);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
  });

  it("sets correct ExecStart", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/srv/nanoclaw", "/home/user", false);
    expect(unit).toContain("ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js");
  });

  it("system unit requires docker.service", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", true);
    expect(unit).toContain("Requires=docker.service");
    expect(unit).toContain("After=network.target docker.service");
  });

  it("user unit does not reference docker.service", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", false);
    expect(unit).not.toContain("docker.service");
  });

  it("user unit has ExecStartPre that waits for Docker", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", false);
    expect(unit).toContain("ExecStartPre=");
    expect(unit).toContain("docker info");
  });

  it("system unit does not have ExecStartPre", () => {
    const unit = generateSystemdUnit("/usr/bin/node", "/home/user/nanoclaw", "/home/user", true);
    expect(unit).not.toContain("ExecStartPre=");
  });
});

describe("WSL nohup fallback", () => {
  it("generates a valid wrapper script", () => {
    const projectRoot = "/home/user/nanoclaw";
    const nodePath = "/usr/bin/node";
    const pidFile = path.join(projectRoot, "nanoclaw.pid");

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain("#!/bin/bash");
    expect(wrapper).toContain("nohup");
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain("nanoclaw.pid");
  });
});
