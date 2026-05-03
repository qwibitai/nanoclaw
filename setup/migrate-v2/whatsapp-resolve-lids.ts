/**
 * migrate-v2 step: resolve WhatsApp LIDs for migrated DM messaging_groups.
 *
 * Why this exists
 * ───────────────
 * v1 stored every WhatsApp DM as `<phone>@s.whatsapp.net`. v2's WA adapter
 * sometimes resolves the chat to `<lid>@lid` instead — when WhatsApp
 * delivers a message via the LID protocol and Baileys hasn't yet learned
 * a LID→phone mapping for that contact (cold cache after migration). The
 * router then can't find the phone-keyed messaging_group and silently
 * drops the message at router.ts:184 — until the LID is learned (which
 * happens lazily, message-by-message, via `chats.phoneNumberShare`).
 *
 * Baileys persists LID↔phone mappings to disk as
 * `store/auth/lid-mapping-<lid>_reverse.json` (LID → phone) and
 * `lid-mapping-<phone>.json` (phone → LID). v1 will already have populated
 * these for every contact it talked to. This step parses the reverse
 * files and writes paired LID-keyed `messaging_groups` +
 * `messaging_group_agents` rows so both `<phone>@s.whatsapp.net` and
 * `<lid>@lid` route to the same agent_group with the same engage rules.
 *
 * No Baileys boot, no network — pure filesystem read. If store/auth is
 * missing or has no reverse mappings, exits 0 with a SKIPPED. Runtime
 * fallback (WA adapter sets isMention=true on DMs → router auto-creates
 * with `unknown_sender_policy=request_approval`) handles anything we
 * miss.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/whatsapp-resolve-lids.ts
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../src/config.js';
import { initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { generateId } from './shared.js';

interface RawMessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
}

interface RawWiring {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: string;
  engage_pattern: string | null;
  sender_scope: string;
  ignored_message_policy: string;
  session_mode: string;
  priority: number;
}

const REVERSE_FILE_RE = /^lid-mapping-(\d+)_reverse\.json$/;

/**
 * Read store/auth/lid-mapping-*_reverse.json into a Map<lidUser, phoneUser>.
 * Returns an empty Map if the directory doesn't exist.
 */
function readReverseMappings(authDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(authDir)) return out;
  for (const entry of fs.readdirSync(authDir)) {
    const m = REVERSE_FILE_RE.exec(entry);
    if (!m) continue;
    const lidUser = m[1];
    try {
      const raw = fs.readFileSync(path.join(authDir, entry), 'utf-8').trim();
      // The file content is a JSON-encoded string: `"<phone>"`
      const phoneUser = JSON.parse(raw);
      if (typeof phoneUser !== 'string' || phoneUser.length === 0) continue;
      out.set(lidUser, phoneUser);
    } catch {
      // Skip malformed entries — best-effort.
    }
  }
  return out;
}

function phoneUserOf(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

function main(): void {
  const authDir = path.join(process.cwd(), 'store', 'auth');
  const reverse = readReverseMappings(authDir);

  if (reverse.size === 0) {
    console.log('SKIPPED:no lid-mapping-*_reverse.json files in store/auth');
    process.exit(0);
  }

  // phoneUser → lidJid (the form we'll write to messaging_groups)
  const phoneUserToLidJid = new Map<string, string>();
  for (const [lidUser, phoneUser] of reverse) {
    phoneUserToLidJid.set(phoneUser, `${lidUser}@lid`);
  }

  const v2DbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(v2DbPath)) {
    console.error('FAIL:v2.db not found — run db step first');
    process.exit(1);
  }

  const v2Db = initDb(v2DbPath);
  runMigrations(v2Db);

  const phoneRows = v2Db
    .prepare(
      `SELECT id, channel_type, platform_id FROM messaging_groups
       WHERE channel_type='whatsapp' AND platform_id LIKE '%@s.whatsapp.net'`,
    )
    .all() as RawMessagingGroup[];

  if (phoneRows.length === 0) {
    console.log('SKIPPED:no whatsapp DM messaging_groups to resolve');
    v2Db.close();
    process.exit(0);
  }

  // Pull existing wirings so each new alias gets the same agent_group +
  // engage rules as the phone-keyed row.
  const placeholders = phoneRows.map(() => '?').join(',');
  const wiringRows = v2Db
    .prepare(`SELECT * FROM messaging_group_agents WHERE messaging_group_id IN (${placeholders})`)
    .all(...phoneRows.map((r) => r.id)) as RawWiring[];

  const wiringsByMg = new Map<string, RawWiring[]>();
  for (const w of wiringRows) {
    const arr = wiringsByMg.get(w.messaging_group_id) ?? [];
    arr.push(w);
    wiringsByMg.set(w.messaging_group_id, arr);
  }

  let resolved = 0;
  let aliased = 0;
  const createdAt = new Date().toISOString();

  for (const row of phoneRows) {
    const phoneUser = phoneUserOf(row.platform_id);
    const lidJid = phoneUserToLidJid.get(phoneUser);
    if (!lidJid) continue;
    resolved++;

    let lidMg = getMessagingGroupByPlatform('whatsapp', lidJid);
    if (!lidMg) {
      createMessagingGroup({
        id: generateId('mg'),
        channel_type: 'whatsapp',
        platform_id: lidJid,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: createdAt,
      });
      lidMg = getMessagingGroupByPlatform('whatsapp', lidJid)!;
    }

    const wirings = wiringsByMg.get(row.id) ?? [];
    for (const w of wirings) {
      if (getMessagingGroupAgentByPair(lidMg.id, w.agent_group_id)) continue;
      createMessagingGroupAgent({
        id: generateId('mga'),
        messaging_group_id: lidMg.id,
        agent_group_id: w.agent_group_id,
        engage_mode: w.engage_mode as 'pattern' | 'mention' | 'mention-sticky',
        engage_pattern: w.engage_pattern,
        sender_scope: w.sender_scope as 'all' | 'admins',
        ignored_message_policy: w.ignored_message_policy as 'drop' | 'queue',
        session_mode: w.session_mode as 'shared' | 'thread',
        priority: w.priority,
        created_at: createdAt,
      });
      aliased++;
    }
  }

  v2Db.close();
  console.log(
    `OK:reverse_mappings=${reverse.size},phone_dms=${phoneRows.length},lids_resolved=${resolved},aliased=${aliased}`,
  );
}

main();
