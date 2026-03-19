import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const VAULT_DIRS = ['people', 'projects', 'preferences', 'decisions', 'reference'];

const VAULT_GITIGNORE = `.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
`;

const OBSIDIAN_CONFIG = {
  'app.json': JSON.stringify({
    livePreview: true,
    showFrontmatter: true,
    defaultViewMode: 'source',
  }, null, 2),
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
    execSync('git init', { cwd: vaultPath, stdio: 'pipe' });
    execSync('git add -A', { cwd: vaultPath, stdio: 'pipe' });
    execSync('git commit -m "Initial knowledge vault"', { cwd: vaultPath, stdio: 'pipe' });
    logger.info({ groupFolder, vaultPath }, 'Knowledge vault initialized');
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to initialize knowledge vault git repo');
  }

  return vaultPath;
}
