/**
 * scripts/recover-jibrain-from-wa-exports.ts
 *
 * One-shot recovery: parse the 5 "WhatsApp Chat - <name> (1).zip" exports in
 * /Users/jibot/switchboard/ops/jibot/exported-logs/ and feed each message in
 * the gap window (2026-05-06 06:38 → present) to the jibrain hook script,
 * mirroring what the live router observer would have written had it been
 * wired during that period.
 *
 * Filename → channel mapping is hard-coded for the 5 known exports; if Joi
 * adds more, extend EXPORT_MAP below. The mapping pulls channel_id +
 * channel_name + capture_mode from the messaging_groups DB rows that the
 * /Users/jibot/nanoclaw/scripts/backfill-listening-modes.ts run just
 * populated, so this script depends on that having run first.
 *
 * Idempotency: writes a manifest at /Users/jibot/scripts/jibrain-recovery-
 * imported.txt of "<channel>|<timestamp>|<senderHash>|<textHash>" tuples and
 * skips already-imported lines on re-run. Safe to re-run.
 *
 * Skipped:
 *   - Anything outside the gap window
 *   - System-event lines (X was added, created this group, end-to-end
 *     encrypted notice, etc.)
 *   - Self ("Joi Ito" or "~ Joi" or any of the resolved-self entries in
 *     /Users/jibot/scripts/jibrain-sender-map.conf)
 *   - Bot messages (lines starting with "jibot:")
 *   - Trimmed text < 20 chars (matches MIN_CONTENT_LEN in the live observer)
 *
 * Usage:
 *   pnpm exec tsx scripts/recover-jibrain-from-wa-exports.ts
 *   pnpm exec tsx scripts/recover-jibrain-from-wa-exports.ts --dry-run
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EXPORTS_DIR =
  process.env.WA_EXPORTS_DIR || path.join(os.homedir(), 'switchboard', 'ops', 'jibot', 'exported-logs');
const HOOK_SCRIPT = process.env.JIBRAIN_HOOK_SCRIPT || path.join(os.homedir(), 'scripts', 'nanoclaw-jibrain-hook.sh');
const MANIFEST_PATH = path.join(os.homedir(), 'scripts', 'jibrain-recovery-imported.txt');
const SENDER_MAP_PATH = path.join(os.homedir(), 'scripts', 'jibrain-sender-map.conf');

// Gap window. Live observer was wired at 2026-05-09 ~16:33 UTC; last v1 hook
// log entry was 2026-05-06 06:37:29. Recover everything in between, plus a
// generous tail (the live observer will dedupe forward via its own batching).
const GAP_START = new Date('2026-05-06T06:38:00Z');
const GAP_END = new Date(); // now — anything still in the export beyond live coverage falls within this

const DRY = process.argv.includes('--dry-run');

interface ExportInfo {
  zipName: string;
  channelName: string; // YAML channel_name → hook channel_slug
  channelId: string; // WhatsApp JID → hook normalizes to 'wa'
  captureMode: 'standalone' | 'digest';
}

// Hard-coded for the 5 exports Joi provided. Extend if more are added.
const EXPORT_MAP: ExportInfo[] = [
  {
    zipName: 'WhatsApp Chat - #ai-oss (1).zip',
    channelName: 'ai-oss',
    channelId: '120363399876069511@g.us', // resolved from DB lookup below
    captureMode: 'standalone',
  },
  {
    zipName: 'WhatsApp Chat - futures and scenarios AGI (1).zip',
    channelName: 'futures-scenarios-agi',
    channelId: '',
    captureMode: 'standalone',
  },
  {
    zipName: 'WhatsApp Chat - Personal Agents 🦞🦀🛫😱 (1).zip',
    channelName: 'personal-agents',
    channelId: '',
    captureMode: 'standalone',
  },
  {
    zipName: 'WhatsApp Chat - Show and Tell (1).zip',
    channelName: 'show-and-tell',
    channelId: '',
    captureMode: 'standalone',
  },
  {
    zipName: 'WhatsApp Chat - The vibez (code code code) (1).zip',
    channelName: 'vibez',
    channelId: '',
    captureMode: 'digest', // confirmed by YAML
  },
];

/** Resolve channelId per export from the YAML channel configs. */
function resolveChannelIds(): void {
  const yamlDir = path.join(os.homedir(), 'switchboard', 'ops', 'jibot', 'channels');
  const yamlFor: Record<string, string> = {
    'ai-oss': 'whatsapp-ai-oss.yaml',
    'futures-scenarios-agi': 'whatsapp-futures-scenarios-agi.yaml',
    'personal-agents': 'whatsapp-personal-agents.yaml',
    'show-and-tell': 'whatsapp-show-and-tell.yaml',
    vibez: 'whatsapp-vibez.yaml',
  };
  for (const e of EXPORT_MAP) {
    if (e.channelId) continue;
    const yfile = path.join(yamlDir, yamlFor[e.channelName] ?? '');
    if (!fs.existsSync(yfile)) {
      console.warn(`[warn] no YAML for ${e.channelName} at ${yfile} — falling back to dummy @g.us suffix`);
      e.channelId = `${e.channelName}@g.us`;
      continue;
    }
    const raw = fs.readFileSync(yfile, 'utf-8');
    const m = raw.match(/^channel_id:\s*"?([^"\n]+)"?$/m);
    e.channelId = m ? m[1].trim() : `${e.channelName}@g.us`;
  }
}

/** Build a name → 'self' lookup from the existing sender map. */
function loadSelfNames(): Set<string> {
  const self = new Set<string>(['Joi Ito', 'joi', 'Joi', '~ Joi', 'Joi (You)']);
  if (!fs.existsSync(SENDER_MAP_PATH)) return self;
  const raw = fs.readFileSync(SENDER_MAP_PATH, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const value = t.slice(eq + 1).trim();
    if (value.toLowerCase() === 'self') {
      const key = t.slice(0, eq).trim();
      self.add(key);
    }
  }
  return self;
}

interface ParsedMessage {
  ts: Date;
  sender: string;
  text: string;
}

const TS_LINE_RE = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}),\s+(\d{1,2}):(\d{2}):(\d{2})\]\s+([^:]+?):\s*(.*)$/;

function parseChatTxt(content: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  let cur: ParsedMessage | null = null;
  for (const rawLine of content.split('\n')) {
    // Strip BOM, soft-break LRM markers, and leading invisible whitespace.
    const line = rawLine.replace(/^﻿/, '').replace(/^‎+/, '').replace(/\r$/, '');
    const m = line.match(TS_LINE_RE);
    if (m) {
      if (cur) out.push(cur);
      const [, y, mo, d, h, mi, s, sender, text] = m;
      cur = {
        ts: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
        sender: sender.trim(),
        text: text,
      };
    } else if (cur) {
      cur.text += '\n' + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const SYSTEM_PATTERNS: RegExp[] = [
  /Messages and calls are end-to-end encrypted/i,
  /\bcreated this group\b/i,
  /\bwas added\b/i,
  /\bjoined using/i,
  /\bchanged the subject/i,
  /\bchanged the group description/i,
  /\bchanged this group's settings\b/i,
  /\bleft\b\s*$/i,
  /\bremoved\b/i,
  /\bdeleted this message\b/i,
  /‎/, // hidden marker WA uses for system events; broad but rarely on real messages
];

function isSystem(text: string): boolean {
  // The export marks system events with the unicode LRM (U+200E) at content
  // start. Our parseChatTxt strips them from the line prefix; they may still
  // appear inside text for system events. Match them and the patterns above.
  if (text.startsWith('‎')) return true;
  for (const re of SYSTEM_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function loadManifest(): Set<string> {
  if (!fs.existsSync(MANIFEST_PATH)) return new Set();
  return new Set(fs.readFileSync(MANIFEST_PATH, 'utf-8').split('\n').filter(Boolean));
}

function appendManifest(keys: string[]): void {
  if (!keys.length) return;
  fs.appendFileSync(MANIFEST_PATH, keys.join('\n') + '\n');
}

function hashShort(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function manifestKey(channel: string, msg: ParsedMessage): string {
  return `${channel}|${msg.ts.toISOString()}|${hashShort(msg.sender)}|${hashShort(msg.text)}`;
}

interface PerChannelStats {
  channel: string;
  total: number;
  inWindow: number;
  imported: number;
  skippedSelf: number;
  skippedSystem: number;
  skippedShort: number;
  skippedDup: number;
}

function processExport(
  zipPath: string,
  info: ExportInfo,
  manifest: Set<string>,
  selfNames: Set<string>,
): PerChannelStats {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-recovery-'));
  try {
    execFileSync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', tmp]);
  } catch (err) {
    console.error(`[fail] unzip ${zipPath}: ${(err as Error).message}`);
    return {
      channel: info.channelName,
      total: 0,
      inWindow: 0,
      imported: 0,
      skippedSelf: 0,
      skippedSystem: 0,
      skippedShort: 0,
      skippedDup: 0,
    };
  }

  const chatTxt = path.join(tmp, '_chat.txt');
  if (!fs.existsSync(chatTxt)) {
    console.error(`[fail] no _chat.txt in ${zipPath}`);
    return {
      channel: info.channelName,
      total: 0,
      inWindow: 0,
      imported: 0,
      skippedSelf: 0,
      skippedSystem: 0,
      skippedShort: 0,
      skippedDup: 0,
    };
  }

  const all = parseChatTxt(fs.readFileSync(chatTxt, 'utf-8'));
  const stats: PerChannelStats = {
    channel: info.channelName,
    total: all.length,
    inWindow: 0,
    imported: 0,
    skippedSelf: 0,
    skippedSystem: 0,
    skippedShort: 0,
    skippedDup: 0,
  };

  const newKeys: string[] = [];
  for (const msg of all) {
    if (msg.ts < GAP_START || msg.ts > GAP_END) continue;
    stats.inWindow++;
    if (selfNames.has(msg.sender)) {
      stats.skippedSelf++;
      continue;
    }
    if (isSystem(msg.text)) {
      stats.skippedSystem++;
      continue;
    }
    const cleaned = msg.text.trim();
    if (cleaned.length < 20) {
      stats.skippedShort++;
      continue;
    }
    const key = manifestKey(info.channelName, msg);
    if (manifest.has(key)) {
      stats.skippedDup++;
      continue;
    }

    if (!DRY) {
      try {
        execFileSync(
          '/bin/bash',
          [HOOK_SCRIPT, 'process', info.channelId, msg.sender, cleaned, info.channelName, info.captureMode],
          { timeout: 30_000, stdio: 'ignore' },
        );
        newKeys.push(key);
      } catch (err) {
        console.warn(
          `[warn] hook failed: ${info.channelName} ${msg.ts.toISOString()} ${msg.sender.slice(0, 40)} — ${(err as Error).message}`,
        );
      }
    } else {
      newKeys.push(key);
    }
    stats.imported++;
  }

  if (!DRY) appendManifest(newKeys);
  fs.rmSync(tmp, { recursive: true, force: true });
  return stats;
}

function main(): void {
  if (!fs.existsSync(EXPORTS_DIR)) {
    console.error(`Exports dir not found: ${EXPORTS_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(HOOK_SCRIPT)) {
    console.error(`Hook script not found: ${HOOK_SCRIPT}`);
    process.exit(1);
  }
  resolveChannelIds();
  const manifest = loadManifest();
  const selfNames = loadSelfNames();

  console.log(
    `${DRY ? '[DRY-RUN] ' : ''}Recovering jibrain intake from WA exports`,
    `\n  exports : ${EXPORTS_DIR}`,
    `\n  hook    : ${HOOK_SCRIPT}`,
    `\n  window  : ${GAP_START.toISOString()} → ${GAP_END.toISOString()}`,
    `\n  manifest: ${MANIFEST_PATH} (${manifest.size} prior keys)`,
  );

  const allStats: PerChannelStats[] = [];
  for (const e of EXPORT_MAP) {
    const zipPath = path.join(EXPORTS_DIR, e.zipName);
    if (!fs.existsSync(zipPath)) {
      console.warn(`[skip] missing: ${e.zipName}`);
      continue;
    }
    console.log(`\nProcessing ${e.channelName} (${e.zipName})...`);
    const s = processExport(zipPath, e, manifest, selfNames);
    allStats.push(s);
    console.log(
      `  total=${s.total} inWindow=${s.inWindow} imported=${s.imported}` +
        ` skip(self/system/short/dup)=${s.skippedSelf}/${s.skippedSystem}/${s.skippedShort}/${s.skippedDup}`,
    );
  }

  console.log('\n── Summary ────────────────────────────────────────────');
  const totals = allStats.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      inWindow: acc.inWindow + s.inWindow,
      imported: acc.imported + s.imported,
    }),
    { total: 0, inWindow: 0, imported: 0 },
  );
  console.log(`Channels processed: ${allStats.length}`);
  console.log(`Total messages in exports: ${totals.total}`);
  console.log(`Messages in gap window:    ${totals.inWindow}`);
  console.log(`Messages imported:         ${totals.imported}${DRY ? ' (dry-run; nothing actually written)' : ''}`);
}

main();
