import fs from 'fs';
import path from 'path';

import type { OneCLI } from '@onecli-sh/sdk';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import type { AvailableGroup } from '../container-runner.js';
import { getAllChats } from '../db.js';
import { setRegisteredGroup } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

/**
 * Best-effort (non-blocking) call to OneCLI to ensure there is an
 * agent identity for this group's folder. Main groups use the default
 * OneCLI agent so we skip them.
 */
export function ensureOneCLIAgent(
  onecli: OneCLI,
  jid: string,
  group: RegisteredGroup,
): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

export interface RegisterGroupDeps {
  onecli: OneCLI;
  registeredGroups: Record<string, RegisteredGroup>;
}

/**
 * Side-effects:
 *   • mutates {@link RegisterGroupDeps.registeredGroups}
 *   • writes the DB row via {@link setRegisteredGroup}
 *   • creates `groups/<folder>/logs/` on disk
 *   • copies `groups/main|global/CLAUDE.md` → `groups/<folder>/CLAUDE.md`
 *     when the target doesn't already exist
 *   • schedules an async {@link ensureOneCLIAgent} call
 */
export function registerGroup(
  deps: RegisterGroupDeps,
  jid: string,
  group: RegisteredGroup,
): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  deps.registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  ensureOneCLIAgent(deps.onecli, jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Return the list of Telegram/WhatsApp/… groups known from stored
 * chat metadata, ordered by most recent activity. Groups already
 * registered in the orchestrator's state are flagged.
 */
export function getAvailableGroups(
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
