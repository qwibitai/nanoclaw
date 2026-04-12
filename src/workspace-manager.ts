import crypto from "crypto";
import fs from "fs";
import path from "path";

import { ASSISTANT_NAME, GROUPS_DIR } from "./config.js";
import type { ContainerOutput } from "./container-runner.js";
import { runContainerAgent } from "./container-runner.js";
import { isValidGroupFolder, resolveGroupFolderPath } from "./group-folder.js";
import type { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import type { RegisteredGroup, WorkspaceInfo } from "./types.js";

const WORKSPACE_JID_SEPARATOR = "::ws::";
const WORKSPACE_CLOSE_DELAY_MS = 10_000;

export function makeWorkspaceJid(chatJid: string, name: string): string {
  return `${chatJid}${WORKSPACE_JID_SEPARATOR}${name}`;
}

export function parseWorkspaceJid(jid: string): { chatJid: string; name: string } | null {
  const idx = jid.indexOf(WORKSPACE_JID_SEPARATOR);
  if (idx === -1) return null;
  const chatJid = jid.slice(0, idx);
  const name = jid.slice(idx + WORKSPACE_JID_SEPARATOR.length);
  if (!chatJid || !name) return null;
  return { chatJid, name };
}

function makeWorkspaceFolder(parentFolder: string, name: string): string {
  const prefix = `${parentFolder}-ws-`;
  const maxNameLen = 64 - prefix.length;

  if (maxNameLen <= 1) {
    // Parent folder too long — use a short hash
    const hash = crypto
      .createHash("sha256")
      .update(`${parentFolder}::${name}`)
      .digest("hex")
      .slice(0, 16);
    return `ws-${hash}`;
  }

  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, maxNameLen);

  const folder = `${prefix}${safeName}`;
  return isValidGroupFolder(folder) ? folder : `ws-${crypto.createHash("sha256").update(`${parentFolder}::${name}`).digest("hex").slice(0, 16)}`;
}

export interface WorkspaceManagerDeps {
  queue: GroupQueue;
  getParentGroup: (chatJid: string) => RegisteredGroup | undefined;
  onWorkspaceMessage: (chatJid: string, workspaceName: string, text: string) => Promise<void>;
}

export class WorkspaceManager {
  private workspaces = new Map<string, WorkspaceInfo>(); // key: workspaceJid

  constructor(private deps: WorkspaceManagerDeps) {}

  async startWorkspace(
    chatJid: string,
    name: string,
    prompt: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const workspaceJid = makeWorkspaceJid(chatJid, name);

    const existing = this.workspaces.get(workspaceJid);
    if (existing && existing.status !== "stopped") {
      return { ok: false, error: `Workspace "${name}" is already ${existing.status}` };
    }

    const parentGroup = this.deps.getParentGroup(chatJid);
    if (!parentGroup) {
      return { ok: false, error: `No registered group for ${chatJid}` };
    }

    const groupFolder = makeWorkspaceFolder(parentGroup.folder, name);
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupFolder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Invalid workspace folder: ${msg}` };
    }

    // Create workspace folder
    fs.mkdirSync(path.join(groupDir, "logs"), { recursive: true });

    // Copy CLAUDE.md from global template if it doesn't exist
    const groupMdFile = path.join(groupDir, "CLAUDE.md");
    if (!fs.existsSync(groupMdFile)) {
      const templateFile = path.join(GROUPS_DIR, "global", "CLAUDE.md");
      if (fs.existsSync(templateFile)) {
        fs.writeFileSync(groupMdFile, fs.readFileSync(templateFile, "utf-8"));
      }
    }

    const workspaceGroup: RegisteredGroup = {
      name: `workspace:${name}`,
      folder: groupFolder,
      trigger: "",
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    };

    const info: WorkspaceInfo = {
      name,
      chatJid,
      groupFolder,
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    this.workspaces.set(workspaceJid, info);

    const taskId = `ws-${name}-${Date.now()}`;
    this.deps.queue.enqueueTask(workspaceJid, taskId, async () => {
      info.status = "running";
      info.lastActivity = new Date().toISOString();

      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleClose = () => {
        if (closeTimer) return;
        closeTimer = setTimeout(() => {
          this.deps.queue.closeStdin(workspaceJid);
        }, WORKSPACE_CLOSE_DELAY_MS);
      };

      try {
        await runContainerAgent(
          workspaceGroup,
          {
            prompt,
            groupFolder,
            chatJid: workspaceJid,
            isMain: false,
            assistantName: ASSISTANT_NAME,
          },
          (proc, containerName) =>
            this.deps.queue.registerProcess(workspaceJid, proc, containerName, groupFolder),
          async (output: ContainerOutput) => {
            info.lastActivity = new Date().toISOString();
            if (output.result) {
              await this.deps.onWorkspaceMessage(chatJid, name, output.result);
              scheduleClose();
            }
            if (output.status === "success") {
              this.deps.queue.notifyIdle(workspaceJid);
              scheduleClose();
            }
          },
        );
        if (closeTimer) clearTimeout(closeTimer);
      } catch (err) {
        if (closeTimer) clearTimeout(closeTimer);
        logger.error({ workspace: name, chatJid, err }, "Workspace container error");
      } finally {
        info.status = "stopped";
        info.lastActivity = new Date().toISOString();
      }
    });

    logger.info({ workspace: name, chatJid, groupFolder }, "Workspace enqueued");
    return { ok: true };
  }

  sendToWorkspace(chatJid: string, name: string, message: string): boolean {
    const workspaceJid = makeWorkspaceJid(chatJid, name);
    const info = this.workspaces.get(workspaceJid);
    if (!info || info.status === "stopped") return false;
    return this.deps.queue.sendMessage(workspaceJid, message);
  }

  stopWorkspace(chatJid: string, name: string): boolean {
    const workspaceJid = makeWorkspaceJid(chatJid, name);
    const info = this.workspaces.get(workspaceJid);
    if (!info || info.status === "stopped") return false;
    this.deps.queue.closeStdin(workspaceJid);
    info.status = "stopped";
    return true;
  }

  getWorkspaces(chatJid: string): WorkspaceInfo[] {
    return Array.from(this.workspaces.values()).filter((w) => w.chatJid === chatJid);
  }

  getWorkspace(chatJid: string, name: string): WorkspaceInfo | undefined {
    return this.workspaces.get(makeWorkspaceJid(chatJid, name));
  }
}
