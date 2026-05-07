/**
 * Compact display-name mentions (`@DisplayName`) in outgoing Slack
 * messages back into Slack's mention syntax (`<@UXXXX>`).
 *
 * The agent writes `@PersonName` in its reply; Slack's API needs the
 * `<@UID>` form to render and notify properly. The 1.x equivalent
 * (commits ef171d6 + a3128a7) used both the live SDK userCache and
 * the static identity index, with multi-alias matching (name, handle,
 * display_name, first + last, first alone if unique). 2.0 moves the
 * userCache into `@chat-adapter/slack`'s internals, so this port uses
 * the static index only — covers the curated cases (which is what the
 * 1.x regression test for "Sean Bonner" exercised).
 *
 * Exported as `transformOutboundText` for the Chat SDK bridge.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_INDEX_PATH = path.join(
  process.env.HOME || os.homedir(),
  'switchboard',
  'ops',
  'jibot',
  'identity-index.json',
);

interface IdentityEntry {
  name?: string;
  handle?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
}

type Cache = {
  mtimeMs: number;
  sortedAliases: Array<[string, string]>;
};

// Cache per (indexPath, namespace) so multi-workspace bridges don't trample
// each other's lookups when their identity indexes share a path on disk.
const _caches = new Map<string, Cache>();

/** Test-only: clear the in-process cache. */
export function resetSlackMentionsCache(): void {
  _caches.clear();
}

/**
 * Decide whether `jid` belongs to the workspace under consideration. With
 * `namespace` set, we only resolve `slack:<namespace>:<userId>` entries;
 * with namespace omitted we accept any slack: user entry (1.x behavior,
 * single-workspace deployments).
 */
function jidMatchesNamespace(jid: string, namespace?: string): boolean {
  if (!jid.startsWith('slack:') || jid.includes(':channel:')) return false;
  if (!namespace) return true;
  return jid.startsWith(`slack:${namespace}:`);
}

function loadAliases(indexPath: string, namespace?: string): Array<[string, string]> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    return [];
  }
  const cacheKey = `${indexPath}\0${namespace ?? ''}`;
  const cached = _caches.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.sortedAliases;

  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return [];
  }
  let index: Record<string, IdentityEntry>;
  try {
    index = JSON.parse(raw) as Record<string, IdentityEntry>;
  } catch {
    return [];
  }

  // Pre-pass: count first-name occurrences across the workspace's entries
  // so we can skip first-name-only aliases for users whose first name
  // collides within that workspace.
  const firstNameCounts = new Map<string, number>();
  for (const [jid, entry] of Object.entries(index)) {
    if (!jidMatchesNamespace(jid, namespace)) continue;
    const fn = entry.first_name;
    if (!fn) continue;
    const k = fn.toLowerCase().trim();
    if (k) firstNameCounts.set(k, (firstNameCounts.get(k) ?? 0) + 1);
  }

  const nameToId = new Map<string, string>();
  const setIfAbsent = (key: string | undefined, userId: string): void => {
    if (!key) return;
    const k = key.toLowerCase().trim();
    if (!k) return;
    if (!nameToId.has(k)) nameToId.set(k, userId);
  };

  for (const [jid, entry] of Object.entries(index)) {
    if (!jidMatchesNamespace(jid, namespace)) continue;
    // jid format: slack:<namespace>:<userId> — userId is the trailing segment
    const lastColon = jid.lastIndexOf(':');
    if (lastColon < 0) continue;
    const userId = jid.slice(lastColon + 1);
    if (!userId) continue;

    setIfAbsent(entry.name, userId);
    setIfAbsent(entry.handle, userId);
    setIfAbsent(entry.display_name, userId);
    if (entry.first_name && entry.last_name) {
      setIfAbsent(`${entry.first_name} ${entry.last_name}`, userId);
    }
    if (entry.first_name) {
      const fnKey = entry.first_name.toLowerCase().trim();
      if (fnKey && firstNameCounts.get(fnKey) === 1) {
        setIfAbsent(entry.first_name, userId);
      }
    }
  }

  // Longest-first so "Sean Bonner" matches before "Sean".
  const sorted = [...nameToId.entries()].sort((a, b) => b[0].length - a[0].length);
  _caches.set(cacheKey, { mtimeMs: stat.mtimeMs, sortedAliases: sorted });
  return sorted;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `@DisplayName` to `<@UXXXX>` for any name found in the identity
 * index. Falls through unchanged when the index is missing/unreadable.
 *
 * `namespace` scopes the lookup to a specific Slack workspace
 * (`slack:<namespace>:<userId>` jids). Required for multi-workspace
 * deployments so a name like "Mark" doesn't get rewritten to a userId
 * that only exists in a different workspace.
 */
export function compactSlackMentions(text: string, indexPath: string = DEFAULT_INDEX_PATH, namespace?: string): string {
  if (!text || !text.includes('@')) return text;
  const aliases = loadAliases(indexPath, namespace);
  if (aliases.length === 0) return text;

  let result = text;
  for (const [alias, userId] of aliases) {
    // Match @alias as a token: requires word-boundary or end-of-string after,
    // so "@Sean" in "I emailed @SeanBonner today" doesn't get mangled.
    const re = new RegExp(`@${escapeRegex(alias)}(?=$|[^\\w-])`, 'gi');
    result = result.replace(re, `<@${userId}>`);
  }
  return result;
}
