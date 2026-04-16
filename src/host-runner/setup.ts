import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import type { ContainerInput } from '../container-runner.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { syncSkills } from '../skill-sync.js';
import type { RegisteredGroup } from '../types.js';

/** Return the most-recent mtime across every .ts file under `dir`. */
function latestTsMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    const mt = fs.statSync(path.join(dir, entry)).mtimeMs;
    if (mt > newest) newest = mt;
  }
  return newest;
}

export interface HostDirectories {
  groupDir: string;
  ipcDir: string;
  globalDir: string;
  extraDir: string;
  claudeHome: string;
  agentRunnerDir: string;
}

/**
 * Create the per-group directory tree and supporting files needed to run
 * the agent in host mode. Writes are idempotent.
 */
export function setupDirectories(
  group: RegisteredGroup,
  _input: ContainerInput,
): HostDirectories {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // IPC directory (same as container-runner)
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  fs.mkdirSync(globalDir, { recursive: true });

  // Extra mounts directory
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  fs.mkdirSync(extraDir, { recursive: true });

  // Symlink additional mounts into extra dir
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const hostPath = mount.hostPath.replace(/^~/, process.env.HOME || '');
      const linkName = mount.containerPath
        ? path.basename(mount.containerPath)
        : path.basename(hostPath);
      const linkPath = path.join(extraDir, linkName);
      try {
        // Remove stale symlink
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(hostPath, linkPath);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.warn(
          { hostPath, linkPath, err },
          'Failed to create extra mount symlink',
        );
      }
    }
  }

  // Per-group Claude sessions directory
  const claudeHome = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  const settingsFile = path.join(claudeHome, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync built-in skills, then group-specific skills (group wins on collision)
  const skillsDst = path.join(claudeHome, 'skills');
  syncSkills(path.join(projectRoot, 'container', 'skills'), skillsDst);
  syncSkills(path.join(groupDir, 'skills'), skillsDst);

  // Copy agent-runner source into a per-group writable location
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const agentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Compare the newest mtime across *every* .ts in src/ so edits to any
    // post-split module (main.ts, query-runner.ts, ipc.ts, hooks.ts, …)
    // invalidate the per-group cache, not only changes to index.ts.
    const newestSrcMtime = latestTsMtime(agentRunnerSrc);
    const cachedIndex = path.join(agentRunnerDir, 'index.ts');
    const cachedMtime = fs.existsSync(cachedIndex)
      ? fs.statSync(cachedIndex).mtimeMs
      : 0;
    const needsCopy =
      !fs.existsSync(agentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      newestSrcMtime > cachedMtime;
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, agentRunnerDir, { recursive: true });
    }
  }

  return { groupDir, ipcDir, globalDir, extraDir, claudeHome, agentRunnerDir };
}
