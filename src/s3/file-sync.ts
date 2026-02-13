/**
 * Universal S3 File Sync for NanoClaw
 * Extracts the duplicated syncFiles() pattern from sprites-backend + daytona-backend
 * into a single implementation that uploads to B2 sync/ prefix.
 *
 * Uses SHA-256 hash caching to skip uploading unchanged files.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { NanoClawS3 } from './client.js';

/** Content hash cache: skip uploading unchanged files. */
const fileHashCache = new Map<string, string>();

function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Upload a file to S3 only if its content has changed since last upload.
 */
async function syncFileToS3(
  s3: NanoClawS3,
  agentId: string,
  relativePath: string,
  content: string | Buffer,
  cacheKey: string,
): Promise<boolean> {
  const hash = hashContent(content);
  if (fileHashCache.get(cacheKey) === hash) {
    return false; // No change
  }

  await s3.writeSync(agentId, relativePath, content);
  fileHashCache.set(cacheKey, hash);
  return true;
}

export interface SyncFilesOptions {
  agentId: string;
  agentFolder: string;
  isMain: boolean;
  serverFolder?: string;
}

/**
 * Sync all host-side files to S3 for a given agent.
 * This is the universal version of the duplicated syncFiles() in sprites-backend and daytona-backend.
 */
export async function syncFilesToS3(
  s3: NanoClawS3,
  opts: SyncFilesOptions,
): Promise<number> {
  const projectRoot = process.cwd();
  const syncOps: Promise<boolean>[] = [];

  // Group CLAUDE.md
  const groupClaudeMd = path.join(GROUPS_DIR, opts.agentFolder, 'CLAUDE.md');
  if (fs.existsSync(groupClaudeMd)) {
    const content = fs.readFileSync(groupClaudeMd, 'utf-8');
    syncOps.push(syncFileToS3(s3, opts.agentId, 'claude-md', content, `${opts.agentId}:CLAUDE.md`));
  }

  // Global CLAUDE.md (non-main only)
  if (!opts.isMain) {
    const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMd)) {
      const content = fs.readFileSync(globalClaudeMd, 'utf-8');
      syncOps.push(syncFileToS3(s3, opts.agentId, 'global-claude-md', content, `${opts.agentId}:global-CLAUDE.md`));
    }
  }

  // Server CLAUDE.md (if applicable)
  if (opts.serverFolder) {
    const serverClaudeMd = path.join(GROUPS_DIR, opts.serverFolder, 'CLAUDE.md');
    if (fs.existsSync(serverClaudeMd)) {
      const content = fs.readFileSync(serverClaudeMd, 'utf-8');
      syncOps.push(syncFileToS3(s3, opts.agentId, 'server-claude-md', content, `${opts.agentId}:server-CLAUDE.md`));
    }
  }

  // Environment file
  const envFile = path.join(DATA_DIR, 'env', 'env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    syncOps.push(syncFileToS3(s3, opts.agentId, 'env', content, `${opts.agentId}:env`));
  }

  // Agent-runner source files
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner', 'src');
  if (fs.existsSync(agentRunnerDir)) {
    for (const file of fs.readdirSync(agentRunnerDir)) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(agentRunnerDir, file), 'utf-8');
      syncOps.push(syncFileToS3(s3, opts.agentId, `agent-runner/src/${file}`, content, `${opts.agentId}:agent-runner:${file}`));
    }
  }

  // Agent-runner package.json
  const agentPkgJson = path.join(projectRoot, 'container', 'agent-runner', 'package.json');
  if (fs.existsSync(agentPkgJson)) {
    const content = fs.readFileSync(agentPkgJson, 'utf-8');
    syncOps.push(syncFileToS3(s3, opts.agentId, 'agent-runner/package.json', content, `${opts.agentId}:agent-runner:package.json`));
  }

  // Entrypoint
  const entrypoint = path.join(projectRoot, 'container', 'entrypoint.sh');
  if (fs.existsSync(entrypoint)) {
    const content = fs.readFileSync(entrypoint, 'utf-8');
    syncOps.push(syncFileToS3(s3, opts.agentId, 'entrypoint.sh', content, `${opts.agentId}:entrypoint`));
  }

  // Skills
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      for (const file of fs.readdirSync(srcDir)) {
        const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
        syncOps.push(syncFileToS3(s3, opts.agentId, `skills/${skillDir}/${file}`, content, `${opts.agentId}:skills:${skillDir}/${file}`));
      }
    }
  }

  // SSH key (if configured)
  const sshKeyPath = path.join(
    process.env.HOME || '/Users/user',
    '.config', 'nanoclaw', 'ssh', 'id_ed25519',
  );
  if (fs.existsSync(sshKeyPath)) {
    const content = fs.readFileSync(sshKeyPath);
    syncOps.push(syncFileToS3(s3, opts.agentId, 'ssh/id_ed25519', content, `${opts.agentId}:ssh-key`));
  }

  const results = await Promise.all(syncOps);
  const uploaded = results.filter(Boolean).length;
  if (uploaded > 0) {
    logger.debug({ agentId: opts.agentId, uploaded, total: results.length }, 'Synced files to S3');
  }
  return uploaded;
}

/**
 * Download a changed file from S3 back to local.
 * Used to sync agent-modified files (CLAUDE.md) back to host.
 */
export async function downloadChangedFileFromS3(
  s3: NanoClawS3,
  agentId: string,
  syncKey: string,
  localPath: string,
  cacheKey: string,
): Promise<boolean> {
  try {
    const content = await s3.readSync(agentId, syncKey);
    if (!content) return false;

    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
    if (!localContent || !content.equals(localContent)) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content);
      fileHashCache.set(cacheKey, hashContent(content));
      logger.debug({ agentId, syncKey }, 'Downloaded updated file from S3');
      return true;
    }
  } catch (err) {
    logger.warn({ agentId, syncKey, error: err }, 'Failed to download file from S3');
  }
  return false;
}

/** Get the file hash cache (for testing/debugging). */
export function getFileHashCache(): Map<string, string> {
  return fileHashCache;
}
