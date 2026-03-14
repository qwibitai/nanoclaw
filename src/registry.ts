import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from './db.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import type { AvailableGroup } from './container-runner.js';

// ── State ──────────────────────────────────────────────────────────

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// ── Accessors ──────────────────────────────────────────────────────

export function getLastTimestamp(): string {
  return lastTimestamp;
}

export function setLastTimestamp(ts: string): void {
  lastTimestamp = ts;
}

export function getSessions(): Record<string, string> {
  return sessions;
}

export function getRegisteredGroups(): Record<string, RegisteredGroup> {
  return registeredGroups;
}

export function getLastAgentTimestamp(): Record<string, string> {
  return lastAgentTimestamp;
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

// ── State persistence ──────────────────────────────────────────────

export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

// ── Session updates ────────────────────────────────────────────────

export function updateSession(folder: string, sessionId: string): void {
  sessions[folder] = sessionId;
  setSession(folder, sessionId);
}

// ── Group registration ─────────────────────────────────────────────

export function registerDerivedGroup(childJid: string, parentJid: string): void {
  const parent = registeredGroups[parentJid];
  if (!parent) {
    logger.warn({ childJid, parentJid }, 'Cannot derive group: parent not found');
    return;
  }

  const isEmailDerived = childJid.startsWith('email:');
  const child: RegisteredGroup = {
    ...parent,
    requiresTrigger: isEmailDerived ? false : parent.requiresTrigger,
  };

  registeredGroups[childJid] = child;
  setRegisteredGroup(childJid, child);
  logger.info({ childJid, parentJid, folder: child.folder }, 'Derived group registered');
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  if (
    group.folder.includes('..') ||
    group.folder.includes('/') ||
    group.folder.includes('\\') ||
    group.folder !== path.basename(group.folder)
  ) {
    logger.error({ folder: group.folder }, 'Rejected group registration: invalid folder name');
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  return chats
    .filter((c) =>
      c.jid !== '__group_sync__' &&
      (c.jid.endsWith('@g.us') || c.jid.startsWith('quo:') || c.jid.startsWith('email:') || c.jid.startsWith('messenger:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
