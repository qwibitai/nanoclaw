/**
 * send-diagnostics.ts — opt-in, privacy-first diagnostics for NanoClaw.
 *
 * Collects system info, accepts event-specific data via --data JSON arg,
 * gates conflict filenames against upstream, and sends to PostHog.
 *
 * Usage:
 *   npx tsx scripts/send-diagnostics.ts \
 *     --event <setup_complete|skill_applied|update_complete> \
 *     [--success|--failure] \
 *     [--data '<json>'] \
 *     [--dry-run]
 *
 * Never exits non-zero on telemetry failures.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const POSTHOG_ENDPOINT = 'https://us.i.posthog.com/capture/';
const POSTHOG_TOKEN = 'phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP';
const SEND_TIMEOUT_MS = 5000;

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const STATE_YAML_PATH = path.join(PROJECT_ROOT, '.nanoclaw', 'state.yaml');

// --- Args ---

function parseArgs(): {
  event: string;
  success?: boolean;
  data: Record<string, unknown>;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let event = '';
  let success: boolean | undefined;
  let data: Record<string, unknown> = {};
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--event':
        event = args[++i] || '';
        break;
      case '--success':
        success = true;
        break;
      case '--failure':
        success = false;
        break;
      case '--data':
        try {
          data = JSON.parse(args[++i] || '{}');
        } catch {
          console.error('Warning: --data JSON parse failed, ignoring');
        }
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  if (!event) {
    console.error('Error: --event is required');
    process.exit(0); // exit 0 — never fail on diagnostics
  }

  return { event, success, data, dryRun };
}

// --- State (neverAsk) ---

function readState(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(STATE_YAML_PATH, 'utf-8');
    return parseYaml(raw) || {};
  } catch {
    return {};
  }
}

function isNeverAsk(): boolean {
  const state = readState();
  return state.neverAsk === true;
}

export function setNeverAsk(): void {
  const state = readState();
  state.neverAsk = true;
  const dir = path.dirname(STATE_YAML_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_YAML_PATH, stringifyYaml(state));
}

// --- Git helpers ---

/** Resolve the upstream remote ref (could be 'upstream/main' or 'origin/main'). */
function resolveUpstreamRef(): string | null {
  for (const ref of ['upstream/main', 'origin/main']) {
    try {
      execSync(`git rev-parse --verify ${ref}`, {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
      });
      return ref;
    } catch {
      continue;
    }
  }
  return null;
}

// --- System info ---

function getNanoclawVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getNodeMajorVersion(): number | null {
  const match = process.version.match(/^v(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function getContainerRuntime(): string {
  try {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'container-runtime.ts'),
      'utf-8',
    );
    const match = src.match(/CONTAINER_RUNTIME_BIN\s*=\s*['"]([^'"]+)['"]/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isUpstreamCommit(): boolean {
  const ref = resolveUpstreamRef();
  if (!ref) return false;
  try {
    const head = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    execSync(`git merge-base --is-ancestor ${head} ${ref}`, {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function collectSystemInfo(): Record<string, unknown> {
  return {
    nanoclaw_version: getNanoclawVersion(),
    os_platform: process.platform,
    arch: process.arch,
    node_major_version: getNodeMajorVersion(),
    container_runtime: getContainerRuntime(),
    is_upstream_commit: isUpstreamCommit(),
  };
}

// --- Conflict filename gating ---

function getUpstreamFiles(): Set<string> | null {
  const ref = resolveUpstreamRef();
  if (!ref) return null;
  try {
    const output = execSync(`git ls-tree -r --name-only ${ref}`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(output.trim().split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

function gateConflictFiles(data: Record<string, unknown>): void {
  if (!Array.isArray(data.conflict_files)) return;

  const rawFiles: string[] = data.conflict_files;
  const upstreamFiles = getUpstreamFiles();
  const totalCount = rawFiles.length;

  if (!upstreamFiles) {
    // Can't verify — fail-closed
    data.conflict_files = [];
    data.conflict_count = totalCount;
    data.has_non_upstream_conflicts = totalCount > 0;
    return;
  }

  const safe: string[] = [];
  let hasNonUpstream = false;

  for (const file of rawFiles) {
    if (upstreamFiles.has(file)) {
      safe.push(file);
    } else {
      hasNonUpstream = true;
    }
  }

  data.conflict_files = safe;
  data.conflict_count = totalCount;
  data.has_non_upstream_conflicts = hasNonUpstream;
}

// --- Build & send ---

function buildPayload(
  event: string,
  systemInfo: Record<string, unknown>,
  eventData: Record<string, unknown>,
  success?: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    $process_person_profile: false,
    $lib: 'nanoclaw-diagnostics',
    ...systemInfo,
    ...eventData,
  };

  if (success !== undefined) {
    properties.success = success;
  }

  return {
    api_key: POSTHOG_TOKEN,
    event,
    distinct_id: crypto.randomUUID(),
    properties,
  };
}

async function sendToPostHog(
  payload: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(POSTHOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.ok) {
      console.log('Diagnostics sent successfully.');
    } else {
      console.error(
        `Diagnostics send failed (HTTP ${response.status}). This is fine.`,
      );
    }
  } catch (err) {
    console.error('Diagnostics send failed (network error). This is fine.');
  } finally {
    clearTimeout(timeout);
  }
}

// --- Main ---

async function main(): Promise<void> {
  try {
    if (isNeverAsk()) {
      // User opted out permanently — exit silently
      return;
    }

    const { event, success, data, dryRun } = parseArgs();

    // Gate conflict filenames before building payload
    gateConflictFiles(data);

    const systemInfo = collectSystemInfo();
    const payload = buildPayload(event, systemInfo, data, success);

    if (dryRun) {
      // Strip internal fields before showing to user
      const { api_key, distinct_id, ...visible } = payload;
      const props = visible.properties as Record<string, unknown>;
      delete props.$process_person_profile;
      delete props.$lib;
      console.log(JSON.stringify(visible, null, 2));
      return;
    }

    await sendToPostHog(payload);
  } catch (err) {
    // Never fail on diagnostics
    console.error('Diagnostics error (this is fine):', (err as Error).message);
  }
}

main();
