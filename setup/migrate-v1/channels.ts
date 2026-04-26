/**
 * Step: migrate-channels
 *
 * For each channel detected in migrate-db, run the corresponding v2
 * `setup/install-<channel>.sh` script in non-interactive mode. The script
 * copies the adapter from the `channels` branch, installs the pinned
 * dependency, and rebuilds. Credentials in v2 `.env` (migrate-env already
 * copied them) are picked up automatically on the next service restart.
 *
 * This step does NOT run the pairing flow for each channel (that needs
 * interactive prompts). The user is guided through pairing by the normal
 * channel-selection step in setup/auto.ts, which happens immediately after
 * migration. Installing the adapter first means that step won't have to
 * re-install.
 *
 * Channels not supported in v2 are recorded in the handoff as
 * `not_supported` so the skill can raise them with the user.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from '../../src/log.js';
import { emitStatus } from '../status.js';
import {
  installScriptForChannel,
  readHandoff,
  recordStep,
  writeHandoff,
} from './shared.js';

function runScript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MIGRATION_NONINTERACTIVE: '1' },
    });
    // Capture both streams silently — the parent is under a clack spinner,
    // and forwarding to stdout/stderr would break the spinner UI. The full
    // transcript still lands in this step's raw log via the parent's tee
    // (runner.ts: spawnStep writes this step's stdout/stderr to logs/setup-
    // steps/NN-migrate-channels.log already).
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
    child.on('error', () =>
      resolve({ code: 1, stdout, stderr: stderr || 'spawn_error' }),
    );
  });
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-channels', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_CHANNELS', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const channels = h.detected_channels;
  if (channels.length === 0) {
    recordStep('migrate-channels', {
      status: 'skipped',
      fields: { REASON: 'no-channels-detected' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_CHANNELS', { STATUS: 'skipped', REASON: 'no_channels' });
    return;
  }

  const results: typeof h.channels_installed = [];
  const followups: string[] = [];

  for (const ch of channels) {
    const script = installScriptForChannel(ch.channel_type);
    if (!script) {
      results.push({
        channel_type: ch.channel_type,
        status: 'not_supported',
      });
      followups.push(
        `Channel "${ch.channel_type}" has no v2 install script. The /migrate-from-v1 skill should ask the user whether to keep it as an orphan messaging_group or drop it.`,
      );
      continue;
    }

    const absoluteScript = path.join(process.cwd(), script);
    if (!fs.existsSync(absoluteScript)) {
      results.push({
        channel_type: ch.channel_type,
        status: 'failed',
        error: `install script missing at ${script}`,
      });
      followups.push(`Install script for "${ch.channel_type}" missing at ${script} — this is a v2 repo issue, not a user issue.`);
      continue;
    }

    log.info('Running channel install script', { channel: ch.channel_type, script: absoluteScript });
    const { code, stdout, stderr } = await runScript(absoluteScript);
    // Persist the install-script output to a sidecar so the skill can read it
    // if diagnosis is needed. The parent's tee already captures our own
    // stdout/stderr but the nested script's output is lost otherwise.
    try {
      const sidecar = path.join(
        process.cwd(),
        'logs',
        'setup-migration',
        `install-${ch.channel_type}.log`,
      );
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(sidecar, `# ${script}\n# exit ${code}\n\n=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}\n`);
    } catch {
      // Sidecar is diagnostic-only — don't abort if the log dir is unwritable.
    }
    if (code === 0) {
      results.push({ channel_type: ch.channel_type, status: 'success' });
    } else {
      results.push({
        channel_type: ch.channel_type,
        status: 'failed',
        error: stderr.trim().slice(0, 400) || `exit ${code}`,
      });
      followups.push(
        `Installing "${ch.channel_type}" failed (exit ${code}). The /migrate-from-v1 skill should retry ${script} or walk the user through /add-${ch.channel_type}.`,
      );
    }
  }

  const handoffAfter = readHandoff();
  handoffAfter.channels_installed = results;
  handoffAfter.followups = [...new Set([...handoffAfter.followups, ...followups])];
  writeHandoff(handoffAfter);

  // `not_supported` is an expected/known outcome for channels whose v1 adapter
  // has no v2 equivalent yet. It's a followup for the skill to raise — not a
  // partial success. Only real install failures degrade status.
  const anyFailed = results.some((r) => r.status === 'failed');
  const status: 'success' | 'partial' | 'failed' = anyFailed ? 'partial' : 'success';

  recordStep('migrate-channels', {
    status,
    fields: {
      INSTALLED: results.filter((r) => r.status === 'success').length,
      FAILED: results.filter((r) => r.status === 'failed').length,
      NOT_SUPPORTED: results.filter((r) => r.status === 'not_supported').length,
      CHANNELS: results.map((r) => `${r.channel_type}=${r.status}`).join(','),
    },
    notes: followups,
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_CHANNELS', {
    STATUS: status,
    INSTALLED: String(results.filter((r) => r.status === 'success').length),
    FAILED: String(results.filter((r) => r.status === 'failed').length),
    NOT_SUPPORTED: String(results.filter((r) => r.status === 'not_supported').length),
  });
}
