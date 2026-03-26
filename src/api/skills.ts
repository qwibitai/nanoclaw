/**
 * Skills endpoints for the NanoClaw Web UI.
 *
 * - GET /api/skills/installed: Read container/skills/ directory
 * - GET /api/skills/marketplace?q=: Run `npx skills find <query>`, 5-min cache
 * - POST /api/skills/install: Validated execFile, async job model
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

// --- Types ---

export interface InstalledSkill {
  name: string;
  description: string;
  path: string; // relative path from project root
  group?: string; // group folder if per-group skill
  category: 'nanoclaw' | 'container' | 'global' | 'group'; // skill origin
}

export interface MarketplaceSkill {
  name: string;
  description: string;
  repo: string;
  installs?: number;
}

export interface SkillInstallJob {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output: string;
  repo: string;
  startedAt: string;
  requires_restart: boolean; // snake_case: matches API response contract
}

// --- Repo validation ---

/** Strict pattern for GitHub owner/repo format. Rejects shell metacharacters, path traversal. */
export const REPO_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

// --- Marketplace cache ---

interface CacheEntry {
  data: MarketplaceSkill[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 50;
const marketplaceCache = new Map<string, CacheEntry>();

// --- Install job tracking ---

const installJobs = new Map<string, SkillInstallJob>();
const MAX_JOBS = 100;
const MAX_OUTPUT_BYTES = 1_048_576; // 1MB

// --- Installed skills cache (60s TTL — skills only change on install which triggers restart) ---

let cachedInstalledSkills: {
  data: InstalledSkill[];
  timestamp: number;
} | null = null;
const INSTALLED_SKILLS_TTL_MS = 60_000;

// --- Installed skills ---

/**
 * Recursively scan a directory for .md skill files and subdirectories.
 * Handles nested directories (e.g. .claude/commands/bootstrap-commands/bootstrap.md).
 */
/**
 * Scan a skill directory (non-recursive). Each top-level entry is one skill:
 * - Directory with .md files → skill name from frontmatter or dir name
 * - Standalone .md file → skill name from frontmatter or file name
 * Subdirectories within a skill dir (references/, resources/) are ignored.
 */
function scanSkillDirectory(
  dir: string,
  projectRoot: string,
  skills: InstalledSkill[],
  category: InstalledSkill['category'],
  _prefix?: string,
  opts?: { group?: string },
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skill directory — find the first .md file at the top level only
      const skillDir = path.join(dir, entry.name);
      const mdFiles = fs.readdirSync(skillDir).filter((f) => f.endsWith('.md'));
      if (mdFiles.length === 0) continue;

      const mdPath = path.join(skillDir, mdFiles[0]);
      const content = fs.readFileSync(mdPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);

      skills.push({
        name: frontmatter.name || entry.name,
        description: frontmatter.description || `Skill: ${entry.name}`,
        path: path.relative(projectRoot, skillDir),
        category,
        ...(opts?.group ? { group: opts.group } : {}),
      });
    } else if (entry.name.endsWith('.md')) {
      // Standalone .md skill file
      const mdPath = path.join(dir, entry.name);
      const content = fs.readFileSync(mdPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const baseName = entry.name.replace(/\.md$/, '');

      skills.push({
        name: frontmatter.name || baseName,
        description: frontmatter.description || `Skill: ${baseName}`,
        path: path.relative(projectRoot, mdPath),
        category,
        ...(opts?.group ? { group: opts.group } : {}),
      });
    }
  }
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns name and description if found.
 */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: { name?: string; description?: string } = {};

  for (const line of yaml.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch)
      result.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch)
      result.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  return result;
}

/**
 * Read installed skills from container/skills/ and per-group skill directories.
 */
export function getInstalledSkills(): InstalledSkill[] {
  const now = Date.now();
  if (
    cachedInstalledSkills &&
    now - cachedInstalledSkills.timestamp < INSTALLED_SKILLS_TTL_MS
  ) {
    return cachedInstalledSkills.data;
  }

  const skills: InstalledSkill[] = [];
  const projectRoot = process.cwd();

  // Container skills: container/skills/
  const globalSkillsDir = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(globalSkillsDir)) {
    try {
      scanSkillDirectory(globalSkillsDir, projectRoot, skills, 'container');
    } catch {
      // Directory read failed
    }
  }

  // NanoClaw skills: .claude/skills/ (add-whatsapp, add-discord, etc.)
  const nanoclawSkillsDir = path.join(projectRoot, '.claude', 'skills');
  if (fs.existsSync(nanoclawSkillsDir)) {
    try {
      scanSkillDirectory(nanoclawSkillsDir, projectRoot, skills, 'nanoclaw');
    } catch {
      // Directory read failed
    }
  }

  // Global Claude Code skills: ~/.claude/skills/ (design, dev skills synced to container)
  const globalClaudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  // Only scan if it's a different directory than the project-level .claude/skills/
  if (
    globalClaudeSkillsDir !== nanoclawSkillsDir &&
    fs.existsSync(globalClaudeSkillsDir)
  ) {
    try {
      scanSkillDirectory(globalClaudeSkillsDir, projectRoot, skills, 'global');
    } catch {
      // Directory read failed
    }
  }

  // User-level skills: .claude/commands/ (Claude Code slash commands)
  const claudeCommandsDir = path.join(projectRoot, '.claude', 'commands');
  if (fs.existsSync(claudeCommandsDir)) {
    try {
      scanSkillDirectory(claudeCommandsDir, projectRoot, skills, 'nanoclaw');
    } catch {
      // Directory read failed
    }
  }

  // Per-group skills: groups/{name}/.claude/skills/
  if (fs.existsSync(GROUPS_DIR)) {
    try {
      const groupEntries = fs.readdirSync(GROUPS_DIR, {
        withFileTypes: true,
      });
      for (const groupEntry of groupEntries) {
        if (!groupEntry.isDirectory()) continue;
        const groupSkillsDir = path.join(
          GROUPS_DIR,
          groupEntry.name,
          '.claude',
          'skills',
        );
        if (!fs.existsSync(groupSkillsDir)) continue;
        scanSkillDirectory(
          groupSkillsDir,
          projectRoot,
          skills,
          'group',
          undefined,
          { group: groupEntry.name },
        );
      }
    } catch {
      // Groups directory read failed
    }
  }

  cachedInstalledSkills = { data: skills, timestamp: Date.now() };
  return skills;
}

// --- Marketplace search ---

/**
 * Parse `npx skills find` output into structured results.
 * Expected output format is line-based with name, description, and repo info.
 */
function parseSkillsOutput(output: string): MarketplaceSkill[] {
  const skills: MarketplaceSkill[] = [];

  // The skills CLI outputs results in a readable format.
  // Parse lines looking for skill entries.
  const lines = output.split('\n').filter((l) => l.trim());
  let current: Partial<MarketplaceSkill> = {};

  for (const line of lines) {
    // Look for repo pattern (owner/name)
    const repoMatch = line.match(/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/);
    if (repoMatch && !current.repo) {
      current.repo = repoMatch[1];
      // Use the repo name as a fallback name
      if (!current.name) {
        current.name = repoMatch[1].split('/')[1] || repoMatch[1];
      }
    }

    // Check for description-like content (lines without special prefixes)
    if (
      !line.startsWith('#') &&
      !line.startsWith('─') &&
      !line.startsWith('=') &&
      line.trim().length > 10 &&
      !current.description
    ) {
      if (current.repo) {
        current.description = line.trim();
      }
    }

    // Look for install count
    const installMatch = line.match(/(\d+)\s*install/i);
    if (installMatch) {
      current.installs = parseInt(installMatch[1], 10);
    }

    // If we have enough data, push and reset
    if (current.repo && current.name) {
      // Check if next line starts a new entry — push current
      skills.push({
        name: current.name,
        description: current.description || '',
        repo: current.repo,
        installs: current.installs,
      });
      current = {};
    }
  }

  // Push any remaining entry
  if (current.repo && current.name) {
    skills.push({
      name: current.name,
      description: current.description || '',
      repo: current.repo,
      installs: current.installs,
    });
  }

  return skills;
}

/**
 * Search the skills marketplace via `npx skills find`.
 * Results are cached server-side with a 5-minute TTL.
 */
export async function searchMarketplace(query: string): Promise<{
  data: MarketplaceSkill[];
  error?: string;
}> {
  const cacheKey = query.toLowerCase().trim();

  // Check cache
  const cached = marketplaceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { data: cached.data };
  }

  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['skills', 'find', '--', query],
      { timeout: 10_000, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          logger.warn(
            { err: error, query },
            'Skills marketplace search failed',
          );
          resolve({ data: [], error: 'search_unavailable' });
          return;
        }

        const data = parseSkillsOutput(stdout || stderr || '');
        marketplaceCache.set(cacheKey, { data, timestamp: Date.now() });
        // Evict oldest entry if cache exceeds max size
        if (marketplaceCache.size > MAX_CACHE_ENTRIES) {
          let oldestKey: string | null = null;
          let oldestTs = Infinity;
          for (const [key, entry] of marketplaceCache) {
            if (entry.timestamp < oldestTs) {
              oldestTs = entry.timestamp;
              oldestKey = key;
            }
          }
          if (oldestKey) marketplaceCache.delete(oldestKey);
        }
        resolve({ data });
      },
    );

    // Safety: ensure child is killed on timeout
    child.on('error', () => {
      resolve({ data: [], error: 'search_unavailable' });
    });
  });
}

// --- Skill installation ---

/**
 * Start a skill installation job.
 * Returns the job object immediately. The actual install runs asynchronously.
 * Caller is responsible for wiring WS progress notifications via the callbacks.
 */
export function startSkillInstall(
  repo: string,
  onProgress: (jobId: string, output: string) => void,
  onComplete: (jobId: string, success: boolean) => void,
): SkillInstallJob | { error: string; status: number } {
  // Validate repo name
  if (!REPO_PATTERN.test(repo)) {
    return {
      error: `Invalid repo format: must match owner/repo pattern`,
      status: 400,
    };
  }

  // Prune old completed/failed jobs to cap installJobs map
  if (installJobs.size >= MAX_JOBS) {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, j] of installJobs) {
      if (
        (j.status === 'completed' || j.status === 'failed') &&
        new Date(j.startedAt).getTime() < oneHourAgo
      ) {
        installJobs.delete(id);
      }
    }
    // If still over cap, remove oldest entries
    if (installJobs.size >= MAX_JOBS) {
      const sorted = [...installJobs.entries()].sort(
        (a, b) =>
          new Date(a[1].startedAt).getTime() -
          new Date(b[1].startedAt).getTime(),
      );
      while (installJobs.size >= MAX_JOBS && sorted.length > 0) {
        const oldest = sorted.shift()!;
        installJobs.delete(oldest[0]);
      }
    }
  }

  const jobId = crypto.randomUUID();
  const job: SkillInstallJob = {
    jobId,
    status: 'running',
    output: '',
    repo,
    startedAt: new Date().toISOString(),
    requires_restart: true,
  };
  installJobs.set(jobId, job);

  const child = execFile(
    'npx',
    ['skills', 'add', repo],
    { timeout: 120_000, maxBuffer: MAX_OUTPUT_BYTES },
    (error) => {
      if (error) {
        job.status = 'failed';
        const errMsg = error.message || 'Install failed';
        if (job.output.length + errMsg.length <= MAX_OUTPUT_BYTES) {
          job.output += '\n' + errMsg;
        }
        onComplete(jobId, false);
      } else {
        job.status = 'completed';
        onComplete(jobId, true);
      }
    },
  );

  // Stream stdout
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (job.output.length + text.length <= MAX_OUTPUT_BYTES) {
        job.output += text;
        onProgress(jobId, text);
      }
    });
  }

  // Stream stderr
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (job.output.length + text.length <= MAX_OUTPUT_BYTES) {
        job.output += text;
        onProgress(jobId, text);
      }
    });
  }

  return job;
}

/**
 * Get an install job by its ID.
 */
export function getInstallJob(jobId: string): SkillInstallJob | undefined {
  return installJobs.get(jobId);
}

// --- Skill detail (file content + directory tree) ---

export interface SkillFileEntry {
  name: string;
  type: 'file' | 'directory';
  children?: SkillFileEntry[];
}

export interface SkillDetail {
  name: string;
  description: string;
  path: string;
  category: InstalledSkill['category'];
  group?: string;
  content: string; // SKILL.md markdown (frontmatter stripped)
  files: SkillFileEntry[];
}

/**
 * Recursively build a file tree for a directory.
 */
function buildFileTree(dir: string): SkillFileEntry[] {
  const entries: SkillFileEntry[] = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        entries.push({
          name: item.name,
          type: 'directory',
          children: buildFileTree(path.join(dir, item.name)),
        });
      } else {
        entries.push({ name: item.name, type: 'file' });
      }
    }
  } catch {
    // read failed
  }
  // Sort: directories first, then files, alphabetically within each group
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

/**
 * Get full detail for a skill by name: SKILL.md content + file tree.
 */
export function getSkillDetail(skillName: string): SkillDetail | null {
  const skills = getInstalledSkills();
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) return null;

  const projectRoot = process.cwd();
  const absolutePath = path.resolve(projectRoot, skill.path);

  // Verify path is within expected boundaries (prevent traversal)
  if (
    !absolutePath.startsWith(projectRoot) &&
    !absolutePath.startsWith(os.homedir())
  ) {
    return null;
  }

  let content = '';
  let files: SkillFileEntry[] = [];

  try {
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      // Skill is a directory — read SKILL.md and build file tree
      const mdCandidates = ['SKILL.md', 'skill.md'];
      for (const candidate of mdCandidates) {
        const mdPath = path.join(absolutePath, candidate);
        if (fs.existsSync(mdPath)) {
          content = stripFrontmatter(fs.readFileSync(mdPath, 'utf-8'));
          break;
        }
      }
      // Fallback: read first .md file
      if (!content) {
        const mdFiles = fs
          .readdirSync(absolutePath)
          .filter((f) => f.endsWith('.md'));
        if (mdFiles[0]) {
          content = stripFrontmatter(
            fs.readFileSync(path.join(absolutePath, mdFiles[0]), 'utf-8'),
          );
        }
      }
      files = buildFileTree(absolutePath);
    } else if (stat.isFile()) {
      // Standalone .md file — read it directly, no file tree
      content = stripFrontmatter(fs.readFileSync(absolutePath, 'utf-8'));
    }
  } catch {
    // File/directory read failed
  }

  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    category: skill.category,
    group: skill.group,
    content,
    files,
  };
}
