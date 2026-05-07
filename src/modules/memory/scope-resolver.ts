import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

interface CacheEntry {
  groupIds: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const scopeCache = new Map<string, CacheEntry>();

let _groupsDirOverride: string | null = null;
export function setGroupsDirForTest(p: string | null): void {
  _groupsDirOverride = p;
}
export function clearScopeCacheForTest(): void {
  scopeCache.clear();
}

function getGroupsDir(): string {
  return _groupsDirOverride ?? GROUPS_DIR;
}

function cacheKey(callingGroupId: string, scope: 'self' | 'all-groups' | string[]): string {
  return `${callingGroupId}::${Array.isArray(scope) ? scope.join(',') : scope}`;
}

function readContainerJson(folder: string): { agentGroupId?: string; memory?: { enabled?: boolean } } | null {
  const p = path.join(getGroupsDir(), folder, 'container.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as { agentGroupId?: string; memory?: { enabled?: boolean } };
  } catch {
    return null;
  }
}

function getAllMemoryEnabledGroupIds(): string[] {
  const dir = getGroupsDir();
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const folder of folders) {
    const cfg = readContainerJson(folder);
    if (cfg?.memory?.enabled === true && cfg.agentGroupId) {
      ids.push(cfg.agentGroupId);
    }
  }
  return ids;
}

function getFolderGroupId(folder: string): string | null {
  const cfg = readContainerJson(folder);
  if (!cfg?.agentGroupId) {
    console.warn(`[scope-resolver] folder "${folder}" not found or has no agentGroupId — skipping`);
    return null;
  }
  return cfg.agentGroupId;
}

export function resolveRecallScope(callingGroupId: string, scope: 'self' | 'all-groups' | string[]): string[] {
  if (scope === 'self') {
    return [callingGroupId];
  }

  const key = cacheKey(callingGroupId, scope);
  const cached = scopeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.groupIds;
  }

  let groupIds: string[];

  if (scope === 'all-groups') {
    const all = getAllMemoryEnabledGroupIds();
    // Deduplicate and ensure callingGroupId is first
    const set = new Set([callingGroupId, ...all]);
    groupIds = Array.from(set);
  } else {
    // string[] — folder names to resolve
    const resolved: string[] = [];
    for (const folder of scope) {
      const id = getFolderGroupId(folder);
      if (id) resolved.push(id);
    }
    // Deduplicate and ensure callingGroupId is first
    const set = new Set([callingGroupId, ...resolved]);
    groupIds = Array.from(set);
  }

  scopeCache.set(key, { groupIds, expiresAt: Date.now() + CACHE_TTL_MS });
  return groupIds;
}
