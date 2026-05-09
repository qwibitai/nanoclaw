/**
 * scripts/backfill-listening-modes.ts
 *
 * One-shot YAML→DB backfill for the per-channel listening_mode /
 * confidential_intake / capture_mode columns added by migration 015.
 *
 * Reads `~/switchboard/ops/jibot/channels/*.yaml` (the legacy v1 channel
 * config dir, still on disk on jibotmac), and for each YAML that carries
 * any of those fields:
 *
 *   1. Looks up the corresponding `messaging_groups` row by
 *      (channel_type=yaml.platform, platform_id=yaml.channel_id).
 *   2. If the row exists, UPDATEs the columns.
 *   3. If the row does not exist (silent-mode group never @mentioned, so
 *      the v2 router never auto-created it), INSERTs a new row with
 *      sensible defaults so future inbound messages reach the
 *      jibrain-intake observer.
 *
 * Idempotent — run as many times as you like; the script reports CREATED /
 * UPDATED / SKIPPED per file.
 *
 * The deprecation/removal of these YAMLs is out of scope for this script —
 * keep them on disk for now as the source-of-truth for re-runs.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-listening-modes.ts          # apply
 *   pnpm exec tsx scripts/backfill-listening-modes.ts --dry-run
 *   CHANNELS_DIR=/path/to/yamls pnpm exec tsx scripts/backfill-listening-modes.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  setMessagingGroupListeningConfig,
} from '../src/db/messaging-groups.js';
import type { MessagingGroup } from '../src/types.js';

interface YamlChannel {
  platform?: string;
  channel_id?: string;
  channel_name?: string;
  group_name?: string;
  listening_mode?: string;
  confidential_intake?: boolean;
  capture_mode?: string;
  domains?: unknown[];
}

const CHANNELS_DIR = process.env.CHANNELS_DIR || path.join(os.homedir(), 'switchboard', 'ops', 'jibot', 'channels');
const DRY = process.argv.includes('--dry-run');

function normalizeListening(value: unknown): 'attentive' | 'silent' | 'intake' | undefined {
  if (value === 'silent' || value === 'intake' || value === 'attentive') return value;
  return undefined;
}

function normalizeCapture(value: unknown): 'standalone' | 'digest' | undefined {
  if (value === 'digest' || value === 'standalone') return value;
  return undefined;
}

/**
 * v1's wantsConfIntake fallback: if confidential_intake isn't explicit,
 * treat silent + non-empty domains as confidential. Mirrored here so the
 * column reflects the same intent the v1 hook layer used to enforce.
 */
function deriveConfidential(cfg: YamlChannel): 0 | 1 | undefined {
  if (typeof cfg.confidential_intake === 'boolean') return cfg.confidential_intake ? 1 : 0;
  if (cfg.listening_mode === 'silent' && Array.isArray(cfg.domains) && cfg.domains.length > 0) return 1;
  return undefined;
}

interface Stats {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

function processFile(file: string, stats: Stats): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[skip] read failed: ${file} (${(err as Error).message})`);
    stats.failed++;
    return;
  }
  let cfg: YamlChannel;
  try {
    cfg = (parseYaml(raw) || {}) as YamlChannel;
  } catch (err) {
    console.warn(`[skip] yaml parse failed: ${file} (${(err as Error).message})`);
    stats.failed++;
    return;
  }
  if (!cfg.platform || !cfg.channel_id) {
    stats.skipped++;
    return;
  }

  const listening_mode = normalizeListening(cfg.listening_mode);
  const confidential_intake = deriveConfidential(cfg);
  const capture_mode = normalizeCapture(cfg.capture_mode);

  if (listening_mode === undefined && confidential_intake === undefined && capture_mode === undefined) {
    stats.skipped++;
    return;
  }

  const channelType = cfg.platform;
  const platformId = cfg.channel_id;
  const existing = getMessagingGroupByPlatform(channelType, platformId);

  if (existing) {
    if (DRY) {
      console.log(
        `[dry] update ${path.basename(file)} → mg ${existing.id} listening=${listening_mode ?? '–'} conf=${confidential_intake ?? '–'} capture=${capture_mode ?? '–'}`,
      );
    } else {
      setMessagingGroupListeningConfig(existing.id, {
        listening_mode,
        confidential_intake,
        capture_mode,
      });
      console.log(`[updated] ${path.basename(file)} → mg ${existing.id}`);
    }
    stats.updated++;
    return;
  }

  // Synthesize a new messaging_groups row so the observer fires for this
  // channel even when no agent is wired and the channel never receives a
  // @mention. is_group is inferred from the JID for WhatsApp; for other
  // platforms we assume group=true if the YAML carries a group_name.
  const isGroup = /@g\.us$/i.test(platformId) || /@thread\b/i.test(platformId) || Boolean(cfg.group_name);
  const id = `mg-yamlmig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const row: MessagingGroup = {
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: cfg.group_name || cfg.channel_name || null,
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  };

  if (DRY) {
    console.log(
      `[dry] create ${path.basename(file)} → ${id} listening=${listening_mode ?? '–'} conf=${confidential_intake ?? '–'} capture=${capture_mode ?? '–'}`,
    );
  } else {
    createMessagingGroup(row);
    setMessagingGroupListeningConfig(id, {
      listening_mode,
      confidential_intake,
      capture_mode,
    });
    console.log(`[created] ${path.basename(file)} → mg ${id} (${cfg.group_name || cfg.channel_name})`);
  }
  stats.created++;
}

function main(): void {
  if (!fs.existsSync(CHANNELS_DIR)) {
    console.error(`Channels dir does not exist: ${CHANNELS_DIR}`);
    process.exit(1);
  }
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const files = fs
    .readdirSync(CHANNELS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => path.join(CHANNELS_DIR, f));

  console.log(
    `${DRY ? '[DRY-RUN] ' : ''}backfilling listening_mode/confidential_intake/capture_mode from ${files.length} YAMLs`,
  );

  const stats: Stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const f of files) processFile(f, stats);

  console.log(
    `Done. created=${stats.created} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`,
  );
}

main();
