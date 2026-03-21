import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const VAULT_DIRS = [
  'people',
  'projects',
  'preferences',
  'decisions',
  'reference',
];

const VAULT_GITIGNORE = `.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
`;

const OBSIDIAN_CONFIG = {
  'app.json': JSON.stringify(
    {
      livePreview: true,
      showFrontmatter: true,
      defaultViewMode: 'source',
    },
    null,
    2,
  ),
};

export function initKnowledgeVault(groupFolder: string): string {
  const vaultPath = path.join(GROUPS_DIR, groupFolder, 'knowledge');

  if (fs.existsSync(path.join(vaultPath, '.obsidian'))) {
    return vaultPath; // Already initialized
  }

  fs.mkdirSync(vaultPath, { recursive: true });
  for (const dir of VAULT_DIRS) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }

  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });
  for (const [file, content] of Object.entries(OBSIDIAN_CONFIG)) {
    fs.writeFileSync(path.join(obsidianDir, file), content);
  }

  fs.writeFileSync(path.join(vaultPath, '.gitignore'), VAULT_GITIGNORE);

  try {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'NanoClaw',
      GIT_AUTHOR_EMAIL:
        process.env.GIT_AUTHOR_EMAIL || 'noreply@nanoclaw.local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'NanoClaw',
      GIT_COMMITTER_EMAIL:
        process.env.GIT_COMMITTER_EMAIL || 'noreply@nanoclaw.local',
    };
    execSync('git init', { cwd: vaultPath, stdio: 'pipe', env: gitEnv });
    execSync('git add -A', { cwd: vaultPath, stdio: 'pipe', env: gitEnv });
    execSync('git commit -m "Initial knowledge vault"', {
      cwd: vaultPath,
      stdio: 'pipe',
      env: gitEnv,
    });
    logger.info({ groupFolder, vaultPath }, 'Knowledge vault initialized');
  } catch (err) {
    logger.warn(
      { groupFolder, err },
      'Failed to initialize knowledge vault git repo',
    );
  }

  // Ensure the container's node user (uid 1000) can write to the vault
  try {
    chownRecursive(vaultPath, 1000, 1000);
  } catch {
    // Best-effort
  }

  return vaultPath;
}

function chownRecursive(dir: string, uid: number, gid: number): void {
  fs.chownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    fs.chownSync(full, uid, gid);
    if (entry.isDirectory()) {
      chownRecursive(full, uid, gid);
    }
  }
}
