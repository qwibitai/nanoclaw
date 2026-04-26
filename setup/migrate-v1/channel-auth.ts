/**
 * Step: migrate-channel-auth
 *
 * For each channel detected in migrate-db, copy non-.env auth state from v1
 * to the matching v2 location. Env keys are handled by migrate-env (this
 * step reads the registry to confirm they made it over, but doesn't rewrite
 * them). Files are copied from the first matching candidate path in the
 * registry — missing paths are recorded so the skill can prompt the user.
 *
 * Destination uses the same relative path on v2 (e.g. v1 has
 * `data/sessions/baileys/` → v2 gets `data/sessions/baileys/`). If v2 already
 * has a different file/dir at that path, we skip and flag it — never clobber.
 */
import fs from 'fs';
import path from 'path';

import { emitStatus } from '../status.js';
import {
  CHANNEL_AUTH_REGISTRY,
  autoResolveV2Keys,
  readHandoff,
  recordStep,
  v1PathsFor,
  writeHandoff,
} from './shared.js';

/**
 * Copy file or directory tree from src to dst. `force: false` means existing
 * files on the v2 side are never clobbered — important because we'd otherwise
 * overwrite auth state the user may have set up on v2 directly. Returns a
 * rough count of files copied (post-hoc walk of the destination).
 */
function copyRecursive(src: string, dst: string): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
  return countFilesUnder(dst);
}

function countFilesUnder(p: string): number {
  if (!fs.existsSync(p)) return 0;
  if (fs.statSync(p).isFile()) return 1;
  let n = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    n += countFilesUnder(path.join(p, entry.name));
  }
  return n;
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-channel-auth', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_CHANNEL_AUTH', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const channels = h.detected_channels;
  if (channels.length === 0) {
    recordStep('migrate-channel-auth', {
      status: 'skipped',
      fields: { REASON: 'no-channels-detected' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_CHANNEL_AUTH', { STATUS: 'skipped', REASON: 'no_channels' });
    return;
  }

  const v1Paths = v1PathsFor(h.v1_path);
  const v1Env = fs.existsSync(v1Paths.env) ? fs.readFileSync(v1Paths.env, 'utf-8') : '';
  const v1EnvKeys = new Set(
    v1Env
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0].trim())
      .filter(Boolean),
  );

  const results: typeof h.channel_auth = [];
  const followups: string[] = [];
  let anyMissingRequired = false;

  for (const ch of channels) {
    const spec = CHANNEL_AUTH_REGISTRY[ch.channel_type];
    if (!spec) {
      // Unknown channel — give the skill enough context to drive a useful
      // interview instead of a generic "we don't know." Scan v1's .env for
      // keys that look related (substring match on channel name + common
      // suffixes) and list v1 state directories the user should check.
      const haystack = ch.channel_type.toLowerCase();
      const candidateEnvKeys = [...v1EnvKeys].filter((k) => {
        const lk = k.toLowerCase();
        return (
          lk.includes(haystack) ||
          (haystack.length >= 3 && lk.includes(haystack.slice(0, 3)))
        );
      });
      const v1DataDirs = ['data', 'store', 'data/sessions']
        .map((d) => path.join(h.v1_path, d))
        .filter((p) => fs.existsSync(p));

      results.push({
        channel_type: ch.channel_type,
        env_keys_copied: [],
        files_copied: [],
        files_missing: [],
        notes: `Unknown channel (not in CHANNEL_AUTH_REGISTRY). Inferred via ${ch.source}. Candidate v1 env keys: ${candidateEnvKeys.join(', ') || 'none found'}. Check v1 dirs: ${v1DataDirs.join(', ') || '(none)'}.`,
      });
      followups.push(
        `Channel "${ch.channel_type}" (${ch.group_count} group(s), inferred via ${ch.source}) is not in the auth registry. ` +
          `Candidate v1 env keys that may belong to it: ${candidateEnvKeys.length > 0 ? candidateEnvKeys.join(', ') : '(none obvious)'}. ` +
          `Check v1 for on-disk auth state under ${v1DataDirs.join(', ') || '(no standard dirs found)'}. ` +
          `The skill should interview the user, then add a registry entry to setup/migrate-v1/shared.ts for future migrations.`,
      );
      continue;
    }

    const envKeysPresentInV1 = spec.v1EnvKeys.filter((key) => v1EnvKeys.has(key));

    // Check v2's .env for required keys the v2 adapter needs to boot. v1
    // may not have had all of them (e.g. v1's Discord used discord.js
    // directly and never stored DISCORD_PUBLIC_KEY which v2's Chat SDK
    // requires). Try to auto-resolve the gap by calling the channel's API
    // with the v1 credential; fall through to a followup for anything we
    // can't resolve.
    const v2EnvPath = path.join(process.cwd(), '.env');
    const v1EnvMap = new Map<string, string>();
    for (const line of v1Env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      v1EnvMap.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
    }

    // Also let the resolver reach into v2's .env (migrate-env already merged
    // v1 keys into v2). Either source is fine for derivation inputs.
    const v2EnvPre = fs.existsSync(v2EnvPath) ? fs.readFileSync(v2EnvPath, 'utf-8') : '';
    const v2EnvPreMap = new Map<string, string>();
    for (const line of v2EnvPre.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      v2EnvPreMap.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
    }

    const resolved = await autoResolveV2Keys(
      ch.channel_type,
      (key) => v1EnvMap.get(key) ?? v2EnvPreMap.get(key),
    );
    const resolvedKeys = Object.keys(resolved);
    if (resolvedKeys.length > 0) {
      // Append to v2 .env (never overwriting existing values) + sync the
      // container-side copy. Log keys, never values.
      let text = v2EnvPre;
      if (text && !text.endsWith('\n')) text += '\n';
      for (const [key, value] of Object.entries(resolved)) {
        if (v2EnvPreMap.has(key)) continue;
        text += `${key}=${value}\n`;
      }
      fs.writeFileSync(v2EnvPath, text);
      try {
        const containerEnvDir = path.join(process.cwd(), 'data', 'env');
        fs.mkdirSync(containerEnvDir, { recursive: true });
        fs.copyFileSync(v2EnvPath, path.join(containerEnvDir, 'env'));
      } catch {
        // Best-effort; service restart rehydrates it if needed.
      }
    }

    // Re-read v2 .env after possible resolution to compute the real gap.
    const v2Env = fs.existsSync(v2EnvPath) ? fs.readFileSync(v2EnvPath, 'utf-8') : '';
    const v2EnvKeys = new Set(
      v2Env
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('=')[0].trim())
        .filter(Boolean),
    );
    const missingRequired = spec.requiredV2Keys.filter((r) => !v2EnvKeys.has(r.key));
    if (missingRequired.length > 0) {
      anyMissingRequired = true;
      followups.push(
        `Channel "${ch.channel_type}" is missing required v2 keys in .env: ${missingRequired
          .map((r) => `${r.key} (${r.where})`)
          .join('; ')}. The v2 adapter won't boot until these are set.`,
      );
    }

    const filesCopied: string[] = [];
    const filesMissing: string[] = [];

    for (const relPath of spec.candidatePaths) {
      const src = path.join(h.v1_path, relPath);
      if (!fs.existsSync(src)) continue;

      const dst = path.join(process.cwd(), relPath);
      if (fs.existsSync(dst)) {
        followups.push(
          `Channel "${ch.channel_type}": v2 already has ${relPath} — left untouched. Reconcile manually if needed.`,
        );
        filesMissing.push(`${relPath} (already exists in v2)`);
        continue;
      }

      try {
        const count = copyRecursive(src, dst);
        filesCopied.push(`${relPath} (${count} files)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        filesMissing.push(`${relPath} (copy failed: ${message})`);
        followups.push(`Channel "${ch.channel_type}": failed to copy ${relPath} — ${message}`);
      }
    }

    if (spec.candidatePaths.length > 0 && filesCopied.length === 0) {
      filesMissing.push(`(no candidate paths existed under ${h.v1_path})`);
    }

    results.push({
      channel_type: ch.channel_type,
      env_keys_copied: [...envKeysPresentInV1, ...resolvedKeys.map((k) => `${k} (auto-resolved)`)],
      files_copied: filesCopied,
      files_missing: filesMissing,
      notes: spec.note ?? '',
    });
  }

  const handoffAfter = readHandoff();
  handoffAfter.channel_auth = results;
  handoffAfter.followups = [...new Set([...handoffAfter.followups, ...followups])];
  writeHandoff(handoffAfter);

  const anyFileMissing = results.some((r) => r.files_missing.length > 0);
  const anyPartial = anyFileMissing || anyMissingRequired;
  recordStep('migrate-channel-auth', {
    status: anyPartial ? 'partial' : 'success',
    fields: {
      CHANNELS: channels.map((c) => c.channel_type).join(','),
      FILES_COPIED: results.reduce((sum, r) => sum + r.files_copied.length, 0),
      FILES_MISSING: results.reduce((sum, r) => sum + r.files_missing.length, 0),
    },
    notes: followups,
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_CHANNEL_AUTH', {
    STATUS: anyPartial ? 'partial' : 'success',
    CHANNELS: channels.map((c) => c.channel_type).join(','),
    FILES_COPIED: String(results.reduce((sum, r) => sum + r.files_copied.length, 0)),
    FILES_MISSING: String(results.reduce((sum, r) => sum + r.files_missing.length, 0)),
  });
}
