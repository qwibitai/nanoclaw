import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';

export interface PersonChannels {
  slack?: string;
  tg?: string;
  wa?: string;
  email?: string;
  zoom?: string;
  [channel: string]: string | undefined; // open-ended for future channels
}

export interface Person {
  canonical_id: string;
  display_name: string;
  roles: string[];
  channels: PersonChannels;
}

export interface PeopleConfig {
  default_role: string;
  people: Person[];
}

export interface ResolvedIdentity {
  canonical_id: string;
  display_name: string;
  roles: string[];
}

export const PEOPLE_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'people.json',
);

const DEFAULT_CONFIG: PeopleConfig = {
  default_role: 'member',
  people: [],
};

function isValidPerson(entry: unknown): entry is Person {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.canonical_id !== 'string' || e.canonical_id.trim() === '')
    return false;
  if (typeof e.display_name !== 'string') return false;
  if (
    !Array.isArray(e.roles) ||
    e.roles.length === 0 ||
    !e.roles.every((r) => typeof r === 'string')
  )
    return false;
  if (!e.channels || typeof e.channels !== 'object' || Array.isArray(e.channels))
    return false;
  if (
    !Object.values(e.channels as object).every(
      (v) => typeof v === 'string' && v.length > 0,
    )
  )
    return false;
  return true;
}

export const UNKNOWN_CANONICAL_ID = 'unknown';
export const UNKNOWN_DISPLAY_NAME = 'Unknown';

export function loadPeopleConfig(pathOverride?: string): PeopleConfig {
  const filePath = pathOverride ?? PEOPLE_CONFIG_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn({ err, path: filePath }, 'people: cannot read config');
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'people: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  const defaultRole =
    typeof obj.default_role === 'string' ? obj.default_role : 'member';

  const people: Person[] = [];
  if (Array.isArray(obj.people)) {
    for (const entry of obj.people) {
      if (isValidPerson(entry)) {
        people.push(entry);
      } else {
        logger.warn(
          { entry, path: filePath },
          'people: skipping invalid person entry',
        );
      }
    }
  }

  return { default_role: defaultRole, people };
}

export function resolvePerson(
  channel: string,
  rawId: string,
  cfg: PeopleConfig,
): ResolvedIdentity | null {
  for (const person of cfg.people) {
    if (person.channels[channel] === rawId) {
      return {
        canonical_id: person.canonical_id,
        display_name: person.display_name,
        roles: person.roles,
      };
    }
  }
  return null;
}

export function getDefaultIdentity(cfg: PeopleConfig): ResolvedIdentity {
  return {
    canonical_id: UNKNOWN_CANONICAL_ID,
    display_name: UNKNOWN_DISPLAY_NAME,
    roles: [cfg.default_role],
  };
}
