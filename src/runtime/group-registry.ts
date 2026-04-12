import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME as DEFAULT_ASSISTANT_NAME,
  GROUPS_DIR,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { RegisteredGroup, ThinkingOverride } from '../core/types.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { AvailableGroup } from './agent-spawn.js';

interface ChatRow {
  jid: string;
  name: string | null;
  last_message_time: string;
  is_group: boolean | number;
}

interface RegisterGroupOptions {
  assistantName?: string;
  groupsDir?: string;
  persist: (jid: string, group: RegisteredGroup) => void;
  ensureOneCLIAgent: (jid: string, group: RegisteredGroup) => void;
}

export function registerGroup(
  registeredGroups: Record<string, RegisteredGroup>,
  jid: string,
  group: RegisteredGroup,
  options: RegisterGroupOptions,
): void {
  const assistantName = options.assistantName ?? DEFAULT_ASSISTANT_NAME;
  const groupsDir = options.groupsDir ?? GROUPS_DIR;

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  options.persist(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      groupsDir,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (assistantName !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${assistantName}`);
        content = content.replace(/You are Andy/g, `You are ${assistantName}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  options.ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

export function setGroupModelOverride(
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid: string,
  model: string | undefined,
  persist: (jid: string, group: RegisteredGroup) => void,
): void {
  const existingGroup = registeredGroups[chatJid];
  if (!existingGroup) return;

  const prevModel = existingGroup.agentConfig?.model;
  if (prevModel === model) return;

  const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
  if (model) {
    nextAgentConfig.model = model;
  } else {
    delete nextAgentConfig.model;
  }

  const updatedGroup: RegisteredGroup = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  registeredGroups[chatJid] = updatedGroup;
  persist(chatJid, updatedGroup);
  logger.info(
    {
      group: updatedGroup.name,
      modelOverride: model ?? null,
    },
    'Updated group model override',
  );
}

export function setGroupThinkingOverride(
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid: string,
  thinking: ThinkingOverride | undefined,
  persist: (jid: string, group: RegisteredGroup) => void,
): void {
  const existingGroup = registeredGroups[chatJid];
  if (!existingGroup) return;

  const prevThinking = existingGroup.agentConfig?.thinking;
  if (JSON.stringify(prevThinking || null) === JSON.stringify(thinking || null))
    return;

  const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
  if (thinking) {
    nextAgentConfig.thinking = thinking;
  } else {
    delete nextAgentConfig.thinking;
  }

  const updatedGroup: RegisteredGroup = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  registeredGroups[chatJid] = updatedGroup;
  persist(chatJid, updatedGroup);
  logger.info(
    {
      group: updatedGroup.name,
      thinkingOverride: thinking ?? null,
    },
    'Updated group thinking override',
  );
}

export function listAvailableGroups(
  chats: ChatRow[],
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const registeredJids = new Set(Object.keys(registeredGroups));
  return chats
    .filter((c) => c.jid !== '__group_sync__' && Boolean(c.is_group))
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
