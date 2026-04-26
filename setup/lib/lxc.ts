/**
 * LXC detection — used to enrich Docker-failure messages with the
 * Proxmox-host snippet a user needs to run when their CT is missing the
 * `nesting=1,keyctl=1` features that Docker-in-LXC requires.
 *
 * A process inside the CT can't change its own LXC config — only the
 * Proxmox host operator can. So this is purely informational: detect we
 * are in LXC, surface the right `pct set …` snippet at the right moment,
 * and let the user act on it.
 *
 * Detection layers (most reliable first):
 *   1. systemd-detect-virt --container → `lxc` / `lxc-libvirt`
 *   2. PID 1's environment has `container=lxc` (the layer systemd itself
 *      falls back to; Proxmox's lxc-start always sets this)
 *   3. /dev/.lxc-boot-id exists (set by the lxc package; not formally
 *      documented but a strong marker on Proxmox CTs)
 *
 * Privilege check: /proc/self/uid_map. Privileged shows the identity
 * mapping `0 0 …`; unprivileged shows a non-zero outer uid (usually
 * `0 100000 65536`). Conservative — anything we can't parse is treated
 * as "unknown" and surfaced separately.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

export type LxcInfo = {
  /** True if we're running inside an LXC container. */
  inLxc: boolean;
  /** True = privileged CT, false = unprivileged, null = unknown. */
  privileged: boolean | null;
  /** Which detector fired ('systemd-detect-virt' | 'proc-1-environ' | 'lxc-boot-id' | null). */
  detector: 'systemd-detect-virt' | 'proc-1-environ' | 'lxc-boot-id' | null;
};

export function detectLxc(): LxcInfo {
  const detector = whichDetectorFires();
  if (!detector) {
    return { inLxc: false, privileged: null, detector: null };
  }
  return { inLxc: true, privileged: readPrivilege(), detector };
}

function whichDetectorFires(): LxcInfo['detector'] {
  try {
    const out = execFileSync('systemd-detect-virt', ['--container'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (out === 'lxc' || out === 'lxc-libvirt') return 'systemd-detect-virt';
  } catch {
    // not installed, or returned non-zero (= "none") — fall through
  }
  try {
    const env = fs.readFileSync('/proc/1/environ', 'utf-8');
    if (env.split('\0').some((kv) => kv === 'container=lxc')) {
      return 'proc-1-environ';
    }
  } catch {
    // not readable — fall through
  }
  try {
    if (fs.existsSync('/dev/.lxc-boot-id')) return 'lxc-boot-id';
  } catch {
    // ignore
  }
  return null;
}

function readPrivilege(): boolean | null {
  try {
    // Format: `inside_uid outside_uid range`. Privileged = identity map.
    const map = fs.readFileSync('/proc/self/uid_map', 'utf-8').trim();
    const firstLine = map.split('\n')[0]?.trim();
    if (!firstLine) return null;
    const parts = firstLine.split(/\s+/);
    if (parts.length < 3) return null;
    const insideUid = parts[0];
    const outsideUid = parts[1];
    return insideUid === '0' && outsideUid === '0';
  } catch {
    return null;
  }
}
