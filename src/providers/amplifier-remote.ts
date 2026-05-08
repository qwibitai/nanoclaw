/**
 * Amplifier-remote host-side container config.
 *
 * Reads `~/.config/amplifierd/credentials.env` on the host and ferries the
 * values into the container as -e flags. The credentials file is kept
 * separate from the repo's `.env` (per the original 1.x design — see
 * jibotmac deployment notes; rotation: re-run the macazbd-side helper).
 *
 * The in-container side is `container/agent-runner/src/providers/amplifier-remote.ts`,
 * which reads these same env vars and implements the AgentProvider interface.
 *
 * @added 2026-05 ported from src/runners/amplifier-remote/client.ts (1.x)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CREDS_PATH = path.join(os.homedir(), '.config', 'amplifierd', 'credentials.env');

const FORWARDED_KEYS = [
  'AMPLIFIERD_API_KEY',
  'AMPLIFIERD_BASE_URL',
  'AMPLIFIERD_BUNDLE',
  'AMPLIFIERD_WORKING_DIR',
  'AMPLIFIERD_MAX_PROMPT_BYTES',
  'AMPLIFIERD_TIMEOUT_MS',
  'AMPLIFIERD_ATTACH_PULL_URL',
] as const;

function parseCredsFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) out[key] = val;
  }
  return out;
}

registerProviderContainerConfig('amplifier-remote', () => {
  let content: string;
  try {
    content = fs.readFileSync(CREDS_PATH, 'utf-8');
  } catch (err) {
    log.warn('amplifier-remote: credentials file unreadable — provider will fail at first turn', {
      credsPath: CREDS_PATH,
      err: (err as Error).message,
    });
    return {};
  }

  const parsed = parseCredsFile(content);
  const env: Record<string, string> = {};
  for (const key of FORWARDED_KEYS) {
    if (parsed[key]) env[key] = parsed[key];
  }
  // 1.x ran on the host so 127.0.0.1 / localhost in AMPLIFIERD_BASE_URL
  // resolved to the amplifierd reverse tunnel. 2.0 runs the runner inside
  // a container where those resolve to the container's own loopback —
  // rewrite to host.docker.internal (added via --add-host=host-gateway in
  // buildContainerArgs) so the container can reach the host's port. Also
  // add host.docker.internal to NO_PROXY so OneCLI gateway env vars
  // (HTTPS_PROXY etc., set on every container) don't tunnel the
  // amplifierd call through gateway.onecli.sh — which doesn't know how
  // to resolve the private container hostname and resets the connection.
  if (env.AMPLIFIERD_BASE_URL) {
    env.AMPLIFIERD_BASE_URL = env.AMPLIFIERD_BASE_URL.replace(
      /^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/,
      '$1host.docker.internal',
    );
  }
  env.NO_PROXY = 'host.docker.internal,127.0.0.1,localhost';
  env.no_proxy = env.NO_PROXY;
  return { env };
});

// Internal export for unit tests.
export const __test = { parseCredsFile, FORWARDED_KEYS, CREDS_PATH };
