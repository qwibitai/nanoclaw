/**
 * Event Routing Rules Engine
 *
 * Loads per-group rules from groups/{name}/events.json.
 * Subscribes to the event bus and routes matching events to actions:
 *   - notify: send a message to a channel
 *   - spawn_task: enqueue a task via the executor pool
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { eventBus, type EventBus } from './event-bus.js';
import type { NanoClawEvent } from './events.js';
import { logger } from './logger.js';

// --- Rule types ---

export interface EventMatchRule {
  /** Event source to match (e.g. "gmail", "webhook", "task"). Compared against event.source or event type prefix. */
  source: string;
  /** Key-value patterns to match against event payload. Values support "*" glob prefix/suffix. */
  match?: Record<string, string | number>;
  /** Action to take when the rule matches. */
  action: 'notify' | 'spawn_task';
  /** For notify: channel JID to send to (optional — defaults to group's chat JID). */
  channel?: string;
  /** For notify: priority level (informational). */
  priority?: 'low' | 'normal' | 'high';
  /** For spawn_task: prompt to pass to the agent. */
  prompt?: string;
  /** Human-readable label for the rule. */
  label?: string;
}

export interface EventRulesConfig {
  rules: EventMatchRule[];
}

// --- Rule loading ---

/**
 * Load event rules for a group from groups/{name}/events.json.
 * Returns an empty rules array if the file doesn't exist or is invalid.
 */
export function loadGroupRules(groupFolder: string): EventRulesConfig {
  const filePath = path.join(GROUPS_DIR, groupFolder, 'events.json');
  try {
    if (!fs.existsSync(filePath)) return { rules: [] };
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.rules || !Array.isArray(parsed.rules)) return { rules: [] };
    return parsed as EventRulesConfig;
  } catch (err) {
    logger.warn(
      { groupFolder, err: String(err) },
      'Failed to load event rules',
    );
    return { rules: [] };
  }
}

// --- Pattern matching ---

/**
 * Check if a value matches a pattern string.
 * Supports:
 *   - "*" matches anything
 *   - "*@alto.com" matches suffix
 *   - "urgent*" matches prefix
 *   - exact string match
 */
export function matchPattern(value: unknown, pattern: string): boolean {
  if (pattern === '*') return true;
  const strValue = String(value);
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
    return strValue
      .toLowerCase()
      .includes(pattern.slice(1, -1).toLowerCase());
  }
  if (pattern.startsWith('*')) {
    return strValue.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  }
  if (pattern.endsWith('*')) {
    return strValue
      .toLowerCase()
      .startsWith(pattern.slice(0, -1).toLowerCase());
  }
  return strValue.toLowerCase() === pattern.toLowerCase();
}

/**
 * Check if an event matches a rule.
 */
export function eventMatchesRule(
  event: NanoClawEvent,
  rule: EventMatchRule,
): boolean {
  // Match source: check against event.source or event.type prefix
  const sourceMatch =
    event.source === rule.source ||
    event.type.startsWith(rule.source + '.') ||
    event.type === rule.source;
  if (!sourceMatch) return false;

  // Match payload patterns
  if (rule.match) {
    for (const [key, pattern] of Object.entries(rule.match)) {
      const value = getNestedValue(event.payload, key);
      if (value === undefined) return false;
      if (typeof pattern === 'number') {
        if (Number(value) !== pattern) return false;
      } else {
        if (!matchPattern(value, pattern)) return false;
      }
    }
  }

  return true;
}

/**
 * Get a nested value from an object using dot notation.
 * e.g. getNestedValue({a: {b: 1}}, "a.b") => 1
 */
function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// --- Action execution ---

export interface EventRouterDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  enqueueTask?: (
    chatJid: string,
    prompt: string,
    groupFolder: string,
  ) => void;
  registeredGroups: () => Record<
    string,
    { folder: string; name: string; isMain?: boolean }
  >;
}

/**
 * Format a notification message from an event and rule.
 */
export function formatNotification(
  event: NanoClawEvent,
  rule: EventMatchRule,
): string {
  const priority =
    rule.priority === 'high'
      ? '\u{26A0}\u{FE0F} '
      : rule.priority === 'low'
        ? '\u{2139}\u{FE0F} '
        : '';
  const label = rule.label || `${event.type} from ${event.source}`;
  const payloadSummary = Object.entries(event.payload)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k}: ${v}`)
    .slice(0, 5)
    .join('\n');
  return `${priority}*${label}*\n${payloadSummary}`;
}

/**
 * Process an event against all rules for all groups.
 */
export function processEvent(
  event: NanoClawEvent,
  deps: EventRouterDeps,
): void {
  const groups = deps.registeredGroups();

  for (const [jid, group] of Object.entries(groups)) {
    const config = loadGroupRules(group.folder);
    if (config.rules.length === 0) continue;

    for (const rule of config.rules) {
      if (!eventMatchesRule(event, rule)) continue;

      if (rule.action === 'notify') {
        const targetJid = rule.channel || jid;
        const message = formatNotification(event, rule);
        deps.sendMessage(targetJid, message).catch((err) => {
          logger.warn(
            { jid: targetJid, err: String(err) },
            'Failed to send event notification',
          );
        });
      } else if (rule.action === 'spawn_task' && rule.prompt) {
        if (deps.enqueueTask) {
          deps.enqueueTask(jid, rule.prompt, group.folder);
        } else {
          logger.warn(
            { jid, rule: rule.label },
            'spawn_task action but no enqueueTask function provided',
          );
        }
      }
    }
  }
}

/**
 * Start the event router. Subscribes to all events via onAny()
 * and processes them against per-group rules.
 *
 * Returns an unsubscribe function.
 */
export function startEventRouter(
  deps: EventRouterDeps,
  bus?: EventBus,
): () => void {
  const target = bus ?? eventBus;
  logger.info('Event router started');
  return target.onAny((event) => {
    try {
      processEvent(event, deps);
    } catch (err) {
      logger.error(
        { err: String(err), eventType: event.type },
        'Event router error',
      );
    }
  });
}
