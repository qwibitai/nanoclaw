import fs from 'fs';
import path from 'path';
import type { RegisteredGroup } from '../types.js';

const CHATS_DIR = path.resolve(process.cwd(), 'chats');

export class GroupsSyncHandler {
  private groups = new Map<string, RegisteredGroup>();

  /** Full replacement sync — receives complete group list from PaaS */
  async sync(params: {
    groups: Array<{
      chatJid: string;
      name: string;
      folder: string;
      trigger: string;
      requiresTrigger: boolean;
      isMain: boolean;
      instructions: string;
    }>;
  }): Promise<{ ok: true }> {
    const newGroups = new Map<string, RegisteredGroup>();

    for (const g of params.groups) {
      // Create workspace directory if it doesn't exist
      const workspaceDir = path.join(CHATS_DIR, g.folder);
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }

      newGroups.set(g.chatJid, {
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: g.requiresTrigger,
        isMain: g.isMain,
        ...(g.instructions ? { instructions: g.instructions } : {}),
      });
    }

    // Replace current groups (removed groups just disappear from routing, dirs kept)
    this.groups = newGroups;
    return { ok: true };
  }

  /** Returns current registered groups for channels */
  getRegisteredGroups(): Record<string, RegisteredGroup> {
    const result: Record<string, RegisteredGroup> = {};
    for (const [jid, group] of this.groups) {
      result[jid] = group;
    }
    return result;
  }

  /** Returns list for groups.list method */
  list(): { groups: Array<{ chatJid: string } & RegisteredGroup> } {
    const groups = [...this.groups.entries()].map(([chatJid, g]) => ({
      chatJid,
      ...g,
    }));
    return { groups };
  }
}
