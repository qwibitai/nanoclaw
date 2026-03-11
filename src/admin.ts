/**
 * Admin Command System for NanoClaw
 *
 * Intercepts admin commands (messages starting with /) in the main channel
 * before they reach the regular in-container agent. Admin commands are
 * rejected in group channels with a clear message.
 */
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  SENDER_ALLOWLIST_PATH,
  MOUNT_ALLOWLIST_PATH,
} from './config.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// --- Command Registry ---

export interface AdminCommandContext {
  chatJid: string;
  group: RegisteredGroup;
  registeredGroups: Record<string, RegisteredGroup>;
  sendMessage: (text: string) => Promise<void>;
}

export type AdminCommandHandler = (ctx: AdminCommandContext) => Promise<void>;

interface AdminCommandEntry {
  description: string;
  handler: AdminCommandHandler;
}

const commandRegistry = new Map<string, AdminCommandEntry>();

export function registerAdminCommand(
  name: string,
  description: string,
  handler: AdminCommandHandler,
): void {
  commandRegistry.set(name, { description, handler });
}

export function getAdminCommands(): Map<string, AdminCommandEntry> {
  return commandRegistry;
}

// --- Admin Command Detection ---

const ADMIN_COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/i;

/**
 * Parse an admin command from message content.
 * Returns the command name (without /) if it matches a registered command,
 * or null if not an admin command.
 */
export function parseAdminCommand(content: string): string | null {
  const trimmed = content.trim();
  const match = trimmed.match(ADMIN_COMMAND_PATTERN);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Check if a message content is a registered admin command.
 * Only registered commands are intercepted — unregistered /foo messages
 * pass through to the container agent (they may be slash-skills like
 * /update-nanoclaw that the in-container agent handles).
 */
export function isAdminCommand(content: string): boolean {
  const cmd = parseAdminCommand(content);
  return cmd !== null && commandRegistry.has(cmd);
}

// --- Admin Command Execution ---

export interface AdminInterceptResult {
  intercepted: boolean;
  // If intercepted but rejected (e.g. group channel), the rejection message
  rejectionMessage?: string;
}

/**
 * Try to intercept and handle an admin command.
 *
 * Returns { intercepted: true } if the message was an admin command and was handled.
 * Returns { intercepted: false } if the message is not an admin command.
 * For group channels, returns intercepted with a rejection message.
 */
export async function interceptAdminCommand(
  content: string,
  chatJid: string,
  group: RegisteredGroup,
  registeredGroups: Record<string, RegisteredGroup>,
  sendMessage: (text: string) => Promise<void>,
): Promise<AdminInterceptResult> {
  const commandName = parseAdminCommand(content);
  if (!commandName) {
    return { intercepted: false };
  }

  const entry = commandRegistry.get(commandName);
  if (!entry) {
    // Not a registered admin command — pass through to the container agent.
    // It may be a slash-skill like /update-nanoclaw or /compact.
    return { intercepted: false };
  }

  const isMain = group.isMain === true;

  // Admin commands are main-channel only
  if (!isMain) {
    const msg = `⚠️ Admin commands are only available in the main channel. \`/${commandName}\` cannot be used here.`;
    await sendMessage(msg);
    logger.warn(
      { chatJid, command: commandName },
      'Admin command rejected in group channel',
    );
    return { intercepted: true, rejectionMessage: msg };
  }

  // Execute in main channel
  logger.info({ command: commandName, chatJid }, 'Admin command intercepted');

  await sendMessage(`🔧 *Admin mode activated* — running /${commandName}`);
  try {
    await entry.handler({
      chatJid,
      group,
      registeredGroups,
      sendMessage,
    });
  } catch (err) {
    logger.error({ command: commandName, err }, 'Admin command error');
    await sendMessage(
      `❌ Admin command /${commandName} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await sendMessage('✅ *Admin mode deactivated* — returning to regular mode.');

  return { intercepted: true };
}

// --- Built-in Commands ---

/**
 * /capabilities — Show current configured capabilities in a structured way.
 */
async function handleCapabilities(ctx: AdminCommandContext): Promise<void> {
  const sections: string[] = [];

  // 1. Registered Channels
  const channelNames = getRegisteredChannelNames();
  sections.push(
    '*Channels*\n' +
      (channelNames.length > 0
        ? channelNames.map((c) => `  • ${c}`).join('\n')
        : '  (none configured)'),
  );

  // 2. Registered Groups
  const groups = Object.entries(ctx.registeredGroups);
  if (groups.length > 0) {
    const groupLines = groups.map(([, g]) => {
      const flags: string[] = [];
      if (g.isMain) flags.push('main');
      if (g.requiresTrigger === false) flags.push('no-trigger');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `  • ${g.name}${flagStr} — ${g.folder}`;
    });
    sections.push('*Registered Groups*\n' + groupLines.join('\n'));
  } else {
    sections.push('*Registered Groups*\n  (none)');
  }

  // 3. Available Tools (what the container agent has access to)
  const toolLines = [
    '  *SDK Tools:*',
    '    Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch',
    '    Task, TaskOutput, TaskStop, TodoWrite, Skill, NotebookEdit',
    '    TeamCreate, TeamDelete, SendMessage, ToolSearch',
    '  *MCP Tools (nanoclaw):*',
    '    send_message, schedule_task, list_tasks, pause_task',
    '    resume_task, cancel_task, update_task, register_group',
    '  *Browser:*',
    '    agent-browser (Chromium automation via Bash)',
  ];
  sections.push('*Available Tools*\n' + toolLines.join('\n'));

  // 4. Agent Skills — sourced from per-group applied sessions, not just
  // the container/skills/ source directory.
  const appliedSkills = new Set<string>();

  // Check container/skills/ (source of truth for built-in skills)
  const skillsSrcDir = path.join(process.cwd(), 'container', 'skills');
  try {
    if (fs.existsSync(skillsSrcDir)) {
      for (const f of fs.readdirSync(skillsSrcDir)) {
        if (fs.statSync(path.join(skillsSrcDir, f)).isDirectory()) {
          appliedSkills.add(f);
        }
      }
    }
  } catch {
    // ignore
  }

  // Also check the main group's applied session skills (runtime state)
  const mainGroup = Object.values(ctx.registeredGroups).find((g) => g.isMain);
  if (mainGroup) {
    const sessionSkillsDir = path.join(
      DATA_DIR,
      'sessions',
      mainGroup.folder,
      '.claude',
      'skills',
    );
    try {
      if (fs.existsSync(sessionSkillsDir)) {
        for (const f of fs.readdirSync(sessionSkillsDir)) {
          if (fs.statSync(path.join(sessionSkillsDir, f)).isDirectory()) {
            appliedSkills.add(f);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const skillsList = [...appliedSkills].sort();
  sections.push(
    '*Agent Skills*\n' +
      (skillsList.length > 0
        ? skillsList.map((s) => `  • ${s}`).join('\n')
        : '  (none installed)'),
  );

  // 4. Security Configuration
  const securityLines: string[] = [];

  // Sender allowlist
  try {
    if (fs.existsSync(SENDER_ALLOWLIST_PATH)) {
      securityLines.push('  • Sender allowlist: configured');
    } else {
      securityLines.push(
        '  • Sender allowlist: not configured (all senders allowed)',
      );
    }
  } catch {
    securityLines.push('  • Sender allowlist: unknown');
  }

  // Mount allowlist
  try {
    if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      securityLines.push('  • Mount allowlist: configured');
    } else {
      securityLines.push(
        '  • Mount allowlist: not configured (additional mounts blocked)',
      );
    }
  } catch {
    securityLines.push('  • Mount allowlist: unknown');
  }

  // Container isolation
  securityLines.push('  • Container isolation: enabled (per-group sandboxes)');
  securityLines.push('  • IPC namespaces: per-group (cross-group blocked)');

  sections.push('*Security*\n' + securityLines.join('\n'));

  // 5. Per-group folder status
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      const groupFolders = fs
        .readdirSync(GROUPS_DIR)
        .filter((f) => fs.statSync(path.join(GROUPS_DIR, f)).isDirectory());
      sections.push(
        '*Group Folders*\n' +
          (groupFolders.length > 0
            ? groupFolders.map((f) => `  • ${f}`).join('\n')
            : '  (none)'),
      );
    }
  } catch {
    // ignore
  }

  // 6. Available Admin Commands
  const commands = getAdminCommands();
  const cmdLines = [...commands.entries()].map(
    ([name, entry]) => `  • /${name} — ${entry.description}`,
  );
  sections.push('*Admin Commands*\n' + cmdLines.join('\n'));

  await ctx.sendMessage(sections.join('\n\n'));
}

// Register built-in commands
registerAdminCommand(
  'capabilities',
  'Show current system capabilities, channels, groups, and security config',
  handleCapabilities,
);
