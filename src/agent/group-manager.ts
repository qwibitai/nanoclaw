/**
 * GroupManager — group registration, state persistence, and OneCLI integration.
 */

import fs from 'fs';
import path from 'path';

import type {
  AvailableGroup,
  RegisterGroupOptions,
  RegisteredGroup as PublicRegisteredGroup,
} from '../api/group.js';
import type { RegisteredGroup as InternalRegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { syncAgentCustomizations } from './customization.js';
import type { AgentContext } from './agent-context.js';

// ─── Helpers ────────────────────────────────────────────────────────

export function cloneRegisteredGroup(
  jid: string,
  group: InternalRegisteredGroup,
): PublicRegisteredGroup & { jid: string } {
  return {
    jid,
    name: group.name,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.added_at,
    containerConfig: group.containerConfig
      ? {
          ...group.containerConfig,
          additionalMounts: group.containerConfig.additionalMounts?.map(
            (m) => ({ ...m }),
          ),
        }
      : undefined,
    requiresTrigger: group.requiresTrigger,
    isMain: group.isMain,
  };
}

// ─── GroupManager ───────────────────────────────────────────────────

export class GroupManager {
  private _onecli: any = null;

  constructor(private readonly ctx: AgentContext) {}

  /** Get a snapshot of all registered groups. */
  getRegisteredGroups(): PublicRegisteredGroup[] {
    if (!this.ctx.started) {
      throw new Error('Call start() before getRegisteredGroups()');
    }
    return Object.entries(this.ctx.registeredGroups).map(([jid, group]) =>
      cloneRegisteredGroup(jid, group),
    );
  }

  /** Register a group for message processing. */
  async registerGroup(
    jid: string,
    options: RegisterGroupOptions,
  ): Promise<void> {
    if (!this.ctx.started) {
      throw new Error('Call start() before registerGroup()');
    }

    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(
        options.folder,
        this.ctx.config.groupsDir,
      );
    } catch (err) {
      logger.warn(
        { jid, folder: options.folder, err },
        'Rejecting group with invalid folder',
      );
      return;
    }

    const group: InternalRegisteredGroup = {
      name: options.name,
      folder: options.folder,
      trigger: options.trigger,
      added_at: new Date().toISOString(),
      containerConfig: options.containerConfig,
      requiresTrigger: options.requiresTrigger,
      isMain: options.isMain,
    };

    this.ctx.registeredGroups[jid] = group;
    this.ctx.db.setRegisteredGroup(jid, group);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    this.ensureOneCLIAgent(jid, group);
    logger.info(
      {
        jid,
        name: group.name,
        folder: group.folder,
        agent: this.ctx.name,
      },
      'Group registered',
    );
    this.ctx.emit('group.registered', {
      jid,
      name: group.name,
      folder: group.folder,
    });
  }

  /** Get discovered groups from chat metadata. */
  getAvailableGroups(): AvailableGroup[] {
    if (!this.ctx.started) {
      throw new Error('Call start() before getAvailableGroups()');
    }

    const chats = this.ctx.db.getAllChats();
    const registeredJids = new Set(Object.keys(this.ctx.registeredGroups));
    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  // ─── State persistence ────────────────────────────────────────────

  /** Load persisted state from database. */
  loadState(): void {
    this.ctx.lastTimestamp = this.ctx.db.getRouterState('last_timestamp') || '';
    const agentTs = this.ctx.db.getRouterState('last_agent_timestamp');
    try {
      Object.assign(
        this.ctx.lastAgentTimestamp,
        agentTs ? JSON.parse(agentTs) : {},
      );
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    }
    Object.assign(this.ctx.sessions, this.ctx.db.getAllSessions());
    Object.assign(
      this.ctx.registeredGroups,
      this.ctx.db.getAllRegisteredGroups(),
    );
    logger.info(
      {
        groupCount: Object.keys(this.ctx.registeredGroups).length,
        agent: this.ctx.name,
      },
      'State loaded',
    );
  }

  /** Persist timestamps to database. */
  saveState(): void {
    this.ctx.db.setRouterState('last_timestamp', this.ctx.lastTimestamp);
    this.ctx.db.setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.ctx.lastAgentTimestamp),
    );
  }

  /** Copy CLAUDE.md templates for new groups. */
  copyGroupTemplates(): void {
    const templateDir = path.join(this.ctx.runtimeConfig.packageRoot, 'groups');
    if (!fs.existsSync(templateDir)) return;

    for (const name of ['global', 'main']) {
      const src = path.join(templateDir, name, 'CLAUDE.md');
      const dst = path.join(this.ctx.config.groupsDir, name, 'CLAUDE.md');
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const content = fs.readFileSync(src, 'utf-8');
        fs.writeFileSync(
          dst,
          content.replaceAll(
            '{{ASSISTANT_NAME}}',
            this.ctx.config.assistantName,
          ),
        );
      }
    }
  }

  /** Sync agent-level instructions, skills, and MCP servers. */
  syncAgentCustomizations(): void {
    syncAgentCustomizations({
      instructions: this.ctx.config.instructions,
      skillsSources: this.ctx.config.skillsSources,
      mcpServers: this.ctx.config.mcpServers,
      agentDir: this.ctx.config.agentDir,
      builtinSkillsDir: path.join(
        this.ctx.runtimeConfig.packageRoot,
        'container',
        'skills',
      ),
    });
  }

  /** Ensure OneCLI agents for all registered groups. */
  ensureAllOneCLIAgents(): void {
    for (const [jid, group] of Object.entries(this.ctx.registeredGroups)) {
      this.ensureOneCLIAgent(jid, group);
    }
  }

  // ─── OneCLI ───────────────────────────────────────────────────────

  private async getOneCLI(): Promise<any> {
    if (!this._onecli) {
      try {
        const { OneCLI } = await import('@onecli-sh/sdk');
        this._onecli = new OneCLI({
          url: this.ctx.runtimeConfig.onecliUrl,
        });
      } catch {
        logger.debug('OneCLI SDK not installed');
        return null;
      }
    }
    return this._onecli;
  }

  private ensureOneCLIAgent(jid: string, group: InternalRegisteredGroup): void {
    if (group.isMain) return;
    const identifier = group.folder.toLowerCase().replace(/_/g, '-');
    this.getOneCLI().then((onecli) => {
      if (!onecli) return;
      onecli.ensureAgent({ name: group.name, identifier }).then(
        (res: { created: boolean }) => {
          logger.info(
            { jid, identifier, created: res.created },
            'OneCLI agent ensured',
          );
        },
        (err: unknown) => {
          logger.debug(
            { jid, identifier, err: String(err) },
            'OneCLI agent ensure skipped',
          );
        },
      );
    });
  }
}
