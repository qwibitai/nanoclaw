/**
 * Capability discovery for the NanoClaw Web UI.
 *
 * Feature detection uses meaningful availability checks — not just table
 * existence (since createSchema() creates all tables unconditionally).
 * Checks handler registration + row counts, directory existence, and env vars.
 */
import fs from 'fs';
import path from 'path';

import { getRegisteredChannelNames } from '../channels/registry.js';
import { isWebJid } from '../config.js';
import { COMMIT_DIGEST_TASK_ID } from '../commit-digest.js';
import { DAILY_TASK_ID } from '../daily-notifications.js';
import {
  countAllBacklog,
  countAllMemories,
  countAllShipLog,
  countPendingGates,
  countThreadMetadata,
  taskExistsById,
} from '../db.js';
import type { Capabilities } from './types.js';

// Read version from package.json once at module load
let cachedVersion = '0.0.0';
try {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  cachedVersion = pkg.version || '0.0.0';
} catch {
  // package.json not found — use fallback
}

export interface CapabilityDeps {
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
}

/** Derive channel type from JID prefix. */
function channelFromJid(jid: string): string {
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('slack:')) return 'slack';
  if (jid.startsWith('tg:')) return 'telegram';
  if (isWebJid(jid)) return 'web';
  if (jid.includes('@s.whatsapp.net') || jid.includes('@g.us'))
    return 'whatsapp';
  return 'unknown';
}

// --- Capabilities cache (30s TTL) ---

let cachedCapabilities: { data: Capabilities; timestamp: number } | null = null;
const CAPABILITIES_TTL_MS = 30_000;

export function getCapabilities(deps: CapabilityDeps): Capabilities {
  const now = Date.now();
  if (
    cachedCapabilities &&
    now - cachedCapabilities.timestamp < CAPABILITIES_TTL_MS
  ) {
    return cachedCapabilities.data;
  }
  const groups = deps.getRegisteredGroups();

  // --- Feature detection ---

  // Memory: check if any memories exist (keyword search works even without vec)
  const memoryAvailable = countAllMemories();

  // Backlog: check if any backlog items exist
  const backlogAvailable = countAllBacklog();

  // Ship log: check if any ship log entries exist
  const shipLogAvailable = countAllShipLog();

  // Thread search: check if any thread metadata is indexed
  const threadSearchAvailable = countThreadMetadata();

  // Gate protocol: check if pending gates have ever been created
  const gateProtocolAvailable = countPendingGates();

  // Activity summary / Commit digest: targeted existence check by task ID
  let activitySummaryAvailable = false;
  let commitDigestAvailable = false;
  try {
    activitySummaryAvailable = taskExistsById(DAILY_TASK_ID);
    commitDigestAvailable = taskExistsById(COMMIT_DIGEST_TASK_ID);
  } catch {
    // DB not initialized
  }

  // Tone profiles: check directory existence + .md files
  let toneProfilesAvailable = false;
  try {
    const toneDir = path.resolve(process.cwd(), 'tone-profiles');
    if (fs.existsSync(toneDir)) {
      const files = fs.readdirSync(toneDir);
      toneProfilesAvailable = files.some((f) => f.endsWith('.md'));
    }
  } catch {
    // Directory doesn't exist
  }

  // Ollama: env var check
  const ollamaAvailable = !!(
    process.env.OLLAMA_HOST && process.env.OLLAMA_HOST.trim()
  );

  const result: Capabilities = {
    version: cachedVersion,
    features: {
      memory: memoryAvailable,
      backlog: backlogAvailable,
      ship_log: shipLogAvailable,
      thread_search: threadSearchAvailable,
      tone_profiles: toneProfilesAvailable,
      gate_protocol: gateProtocolAvailable,
      activity_summary: activitySummaryAvailable,
      commit_digest: commitDigestAvailable,
      ollama: ollamaAvailable,
    },
    channels: getRegisteredChannelNames(),
    groups: groups.map((g) => ({ ...g, channel: channelFromJid(g.jid) })),
    folders: [],
  };

  // Aggregate groups by folder for channel-agnostic presentation
  const folderMap = new Map<
    string,
    { folder: string; name: string; channels: Array<{ jid: string; channel: string; name: string }> }
  >();
  for (const g of result.groups) {
    const existing = folderMap.get(g.folder);
    if (existing) {
      existing.channels.push({ jid: g.jid, channel: g.channel, name: g.name });
    } else {
      folderMap.set(g.folder, {
        folder: g.folder,
        name: g.name,
        channels: [{ jid: g.jid, channel: g.channel, name: g.name }],
      });
    }
  }
  result.folders = [...folderMap.values()];

  cachedCapabilities = { data: result, timestamp: Date.now() };
  return result;
}
