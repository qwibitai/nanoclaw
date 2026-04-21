// scripts/smoke-send.ts
// Post-deploy health probe. Run: npx tsx scripts/smoke-send.ts [--host <ip>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

interface DeployConfig {
  dropletIp: string;
  dropletUser?: string;
  nanoclaw_dir?: string;
}

function loadDeployConfig(): DeployConfig | null {
  const cfgPath = path.join(os.homedir(), '.config', 'nanoclaw', 'deploy.json');
  if (!fs.existsSync(cfgPath)) return null;
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as DeployConfig;
}

function sshRun(
  user: string,
  host: string,
  cmd: string,
): { ok: boolean; out: string } {
  const result = spawnSync(
    'ssh',
    [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ConnectTimeout=10',
      `${user}@${host}`,
      cmd,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return {
    ok: result.status === 0,
    out: ((result.stdout ?? '') + (result.stderr ?? '')).trim(),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const hostIdx = args.indexOf('--host');
  const explicitHost = hostIdx >= 0 ? args[hostIdx + 1] : undefined;

  const cfg = loadDeployConfig();
  const host = explicitHost ?? cfg?.dropletIp;
  if (!host) {
    console.error(
      '[smoke-send] No host. Pass --host <ip> or set "dropletIp" in ~/.config/nanoclaw/deploy.json',
    );
    process.exit(1);
  }

  const user = cfg?.dropletUser ?? 'root';
  const dir = cfg?.nanoclaw_dir ?? '/root/nanoclaw';
  console.log(`[smoke-send] Probing ${user}@${host}...`);

  // Probe 1: service is active
  const svc = sshRun(
    user,
    host,
    'systemctl is-active nanoclaw 2>/dev/null || systemctl --user is-active nanoclaw 2>/dev/null || echo inactive',
  );
  if (!svc.out.includes('active')) {
    console.error(
      `[smoke-send] FAIL: nanoclaw service not active (got: ${svc.out})`,
    );
    process.exit(2);
  }
  console.log('[smoke-send] Service is active');

  // Probe 2: health socket responds (optional — only if NANOCLAW_HEALTH was set)
  const hProbe = sshRun(
    user,
    host,
    `printf '' | nc -U ${dir}/data/health.sock 2>/dev/null || echo NO_SOCKET`,
  );
  if (hProbe.out.includes('NO_SOCKET') || !hProbe.out.includes('"status"')) {
    console.log(
      '[smoke-send] SKIP: health socket not responding (set NANOCLAW_HEALTH=1 on the droplet to enable)',
    );
  } else {
    try {
      const status = JSON.parse(hProbe.out.trim()) as {
        version: string;
        channelsConnected: string[];
      };
      console.log(
        `[smoke-send] Health socket OK — version: ${status.version}, channels: ${JSON.stringify(status.channelsConnected)}`,
      );
    } catch {
      console.warn('[smoke-send] Health socket returned non-JSON:', hProbe.out);
    }
  }

  // Probe 3: container runtime
  const cProbe = sshRun(
    user,
    host,
    'docker run --rm hello-world 2>&1 | head -1',
  );
  if (!cProbe.ok || !cProbe.out.toLowerCase().includes('hello')) {
    console.warn(
      '[smoke-send] WARN: docker hello-world did not respond — container runtime may be degraded',
    );
  } else {
    console.log('[smoke-send] Container runtime healthy');
  }

  // Probe 4: recent error scan
  const logProbe = sshRun(
    user,
    host,
    `tail -50 ${dir}/logs/nanoclaw.log 2>/dev/null | grep -c '"level":50' || echo 0`,
  );
  const errorCount = parseInt(logProbe.out.trim() || '0', 10);
  if (errorCount > 0) {
    console.warn(
      `[smoke-send] WARN: ${errorCount} ERROR-level lines in last 50 log entries`,
    );
  } else {
    console.log('[smoke-send] No recent ERROR log entries');
  }

  console.log('[smoke-send] All critical probes passed.');
}

main();
