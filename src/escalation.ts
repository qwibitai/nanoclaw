import fs from 'fs';

import { parse as parseYaml } from 'yaml';

import { logger } from './logger.js';

// Types matching the escalation YAML schema

export interface AdminEntry {
  name: string;
  role: 'domain' | 'technical';
  email?: string;
  telegram?: string;
}

export interface RoutingEntry {
  primary: string;
  cc?: string;
}

export interface GapTypeConfig {
  base_weight: number;
  status: 'needs_input' | 'needs_approval';
  routing: string;
  description?: string;
}

export interface SignalConfig {
  weight: number;
  description?: string;
}

export interface MeanwhileMessages {
  needs_input?: string;
  needs_approval?: string;
}

export interface NotificationConfig {
  [priority: string]: string[];
}

export interface EscalationConfig {
  admins: AdminEntry[];
  routing: Record<string, RoutingEntry>;
  gap_types: Record<string, GapTypeConfig>;
  signals: Record<string, SignalConfig>;
  priority_levels: Record<string, number>;
  notification: NotificationConfig;
  meanwhile?: MeanwhileMessages;
}

export type PriorityLevel = 'critical' | 'high' | 'normal' | 'low';

export interface SignalContext {
  [signalName: string]: boolean;
}

export interface PriorityResult {
  level: PriorityLevel;
  score: number;
  gapType: GapTypeConfig;
  routing: RoutingEntry;
}

export interface NotificationTarget {
  admin: AdminEntry;
  channels: string[];
  role: 'primary' | 'cc';
}

// Validation helpers

function isValidAdmin(obj: unknown): obj is AdminEntry {
  if (!obj || typeof obj !== 'object') return false;
  const a = obj as Record<string, unknown>;
  if (typeof a.name !== 'string' || !a.name) return false;
  if (a.role !== 'domain' && a.role !== 'technical') return false;
  // At least one contact channel required
  if (typeof a.email !== 'string' && typeof a.telegram !== 'string')
    return false;
  return true;
}

function isValidRouting(obj: unknown): obj is RoutingEntry {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return typeof r.primary === 'string' && !!r.primary;
}

function isValidGapType(obj: unknown): obj is GapTypeConfig {
  if (!obj || typeof obj !== 'object') return false;
  const g = obj as Record<string, unknown>;
  if (typeof g.base_weight !== 'number') return false;
  if (g.status !== 'needs_input' && g.status !== 'needs_approval') return false;
  if (typeof g.routing !== 'string' || !g.routing) return false;
  return true;
}

function isValidSignal(obj: unknown): obj is SignalConfig {
  if (!obj || typeof obj !== 'object') return false;
  const s = obj as Record<string, unknown>;
  return typeof s.weight === 'number';
}

// Config loader

export function loadEscalationConfig(
  configPath: string,
): EscalationConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Not an error — verticals may not have escalation config
      return null;
    }
    logger.warn(
      { err, path: configPath },
      'escalation: cannot read config file',
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    logger.warn(
      { err, path: configPath },
      'escalation: invalid YAML in config',
    );
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    logger.warn({ path: configPath }, 'escalation: config is not an object');
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate admins
  if (!Array.isArray(obj.admins) || obj.admins.length === 0) {
    logger.warn({ path: configPath }, 'escalation: missing or empty admins');
    return null;
  }
  const admins: AdminEntry[] = [];
  for (const a of obj.admins) {
    if (isValidAdmin(a)) {
      admins.push(a);
    } else {
      logger.warn(
        { admin: a, path: configPath },
        'escalation: skipping invalid admin entry',
      );
    }
  }
  if (admins.length === 0) {
    logger.warn(
      { path: configPath },
      'escalation: no valid admins after validation',
    );
    return null;
  }

  // Validate routing
  if (!obj.routing || typeof obj.routing !== 'object') {
    logger.warn({ path: configPath }, 'escalation: missing routing section');
    return null;
  }
  const routing: Record<string, RoutingEntry> = {};
  for (const [key, entry] of Object.entries(
    obj.routing as Record<string, unknown>,
  )) {
    if (isValidRouting(entry)) {
      routing[key] = entry;
    } else {
      logger.warn(
        { key, path: configPath },
        'escalation: skipping invalid routing entry',
      );
    }
  }

  // Validate gap types
  if (!obj.gap_types || typeof obj.gap_types !== 'object') {
    logger.warn({ path: configPath }, 'escalation: missing gap_types section');
    return null;
  }
  const gap_types: Record<string, GapTypeConfig> = {};
  for (const [key, entry] of Object.entries(
    obj.gap_types as Record<string, unknown>,
  )) {
    if (isValidGapType(entry)) {
      gap_types[key] = entry;
    } else {
      logger.warn(
        { key, path: configPath },
        'escalation: skipping invalid gap type',
      );
    }
  }

  // Validate signals
  const signals: Record<string, SignalConfig> = {};
  if (obj.signals && typeof obj.signals === 'object') {
    for (const [key, entry] of Object.entries(
      obj.signals as Record<string, unknown>,
    )) {
      if (isValidSignal(entry)) {
        signals[key] = entry;
      } else {
        logger.warn(
          { key, path: configPath },
          'escalation: skipping invalid signal',
        );
      }
    }
  }

  // Validate priority levels
  if (!obj.priority_levels || typeof obj.priority_levels !== 'object') {
    logger.warn(
      { path: configPath },
      'escalation: missing priority_levels section',
    );
    return null;
  }
  const priority_levels: Record<string, number> = {};
  for (const [key, val] of Object.entries(
    obj.priority_levels as Record<string, unknown>,
  )) {
    if (typeof val === 'number') {
      priority_levels[key] = val;
    } else {
      logger.warn(
        { key, path: configPath },
        'escalation: skipping invalid priority level',
      );
    }
  }

  // Validate notification config
  const notification: NotificationConfig = {};
  if (obj.notification && typeof obj.notification === 'object') {
    for (const [key, val] of Object.entries(
      obj.notification as Record<string, unknown>,
    )) {
      if (Array.isArray(val) && val.every((v) => typeof v === 'string')) {
        notification[key] = val;
      } else {
        logger.warn(
          { key, path: configPath },
          'escalation: skipping invalid notification entry',
        );
      }
    }
  }

  // Meanwhile messages (optional)
  const meanwhile: MeanwhileMessages = {};
  if (obj.meanwhile && typeof obj.meanwhile === 'object') {
    const m = obj.meanwhile as Record<string, unknown>;
    if (typeof m.needs_input === 'string')
      meanwhile.needs_input = m.needs_input;
    if (typeof m.needs_approval === 'string')
      meanwhile.needs_approval = m.needs_approval;
  }

  return {
    admins,
    routing,
    gap_types,
    signals,
    priority_levels,
    notification,
    meanwhile,
  };
}

// Priority computation

export function computePriority(
  config: EscalationConfig,
  gapType: string,
  signals: SignalContext,
): PriorityResult {
  const gap = config.gap_types[gapType];
  if (!gap) {
    throw new Error(`Unknown gap type: ${gapType}`);
  }

  // Start with base weight
  let score = gap.base_weight;

  // Add weights for each active signal
  for (const [signalName, active] of Object.entries(signals)) {
    if (active && config.signals[signalName]) {
      score += config.signals[signalName].weight;
    }
  }

  // Resolve priority level — sorted descending by threshold, pick highest matching
  const sortedLevels = Object.entries(config.priority_levels).sort(
    ([, a], [, b]) => b - a,
  );

  let level: PriorityLevel = 'low';
  for (const [name, threshold] of sortedLevels) {
    if (score >= threshold) {
      level = name as PriorityLevel;
      break;
    }
  }

  // Resolve routing
  const routingEntry = config.routing[gap.routing];
  if (!routingEntry) {
    throw new Error(
      `Gap type "${gapType}" references unknown routing category: ${gap.routing}`,
    );
  }

  return { level, score, gapType: gap, routing: routingEntry };
}

// Admin lookup / notification target resolution

export function resolveNotificationTargets(
  config: EscalationConfig,
  priority: string,
): NotificationTarget[] {
  const channels = config.notification[priority] ?? [];
  if (channels.length === 0) return [];

  const targets: NotificationTarget[] = [];

  // For each routing category, resolve the primary and cc admins
  // We return unique admins across all routing categories
  const seenAdmins = new Set<string>();

  for (const [, routingEntry] of Object.entries(config.routing)) {
    const primaryAdmin = config.admins.find(
      (a) => a.name === routingEntry.primary,
    );
    if (primaryAdmin && !seenAdmins.has(primaryAdmin.name)) {
      seenAdmins.add(primaryAdmin.name);
      const adminChannels = filterChannelsForAdmin(primaryAdmin, channels);
      if (adminChannels.length > 0) {
        targets.push({
          admin: primaryAdmin,
          channels: adminChannels,
          role: 'primary',
        });
      }
    }

    if (routingEntry.cc) {
      const ccAdmin = config.admins.find((a) => a.name === routingEntry.cc);
      if (ccAdmin && !seenAdmins.has(ccAdmin.name)) {
        seenAdmins.add(ccAdmin.name);
        const adminChannels = filterChannelsForAdmin(ccAdmin, channels);
        if (adminChannels.length > 0) {
          targets.push({
            admin: ccAdmin,
            channels: adminChannels,
            role: 'cc',
          });
        }
      }
    }
  }

  return targets;
}

function filterChannelsForAdmin(
  admin: AdminEntry,
  requestedChannels: string[],
): string[] {
  return requestedChannels.filter((ch) => {
    if (ch === 'telegram') return !!admin.telegram;
    if (ch === 'email') return !!admin.email;
    return false;
  });
}
