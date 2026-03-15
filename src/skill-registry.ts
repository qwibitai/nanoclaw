/**
 * Skill Registry — discovers and registers agent skills from container/skills/.
 *
 * Each skill directory contains a SKILL.md with YAML front-matter:
 *
 *   ---
 *   name: my-skill
 *   description: What this skill does
 *   allowed-tools: Bash(my-skill:*)
 *   ---
 *
 * The registry scans at startup and watches for changes via fs.watch.
 * A GET /skills HTTP endpoint returns the current registry as JSON.
 */
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';

import { logger } from './logger.js';

export interface SkillEntry {
  name: string;
  description: string;
  file: string;
  allowedTools?: string;
  registeredAt: string;
}

const registry = new Map<string, SkillEntry>();

// --- Front-matter parser ---

/**
 * Parse YAML front-matter from a SKILL.md file.
 * Expects a block delimited by --- lines at the top of the file.
 */
function parseFrontMatter(
  content: string,
): Record<string, string> | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

// --- Scanner ---

function scanSkillFile(skillDir: string, dirName: string): SkillEntry | null {
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;

  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    const meta = parseFrontMatter(content);
    if (!meta?.name) {
      logger.warn({ file: skillFile }, 'Skill file missing name in front-matter');
      return null;
    }

    return {
      name: meta.name,
      description: meta.description || '',
      file: path.relative(process.cwd(), skillFile),
      allowedTools: meta['allowed-tools'],
      registeredAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ file: skillFile, err }, 'Failed to read skill file');
    return null;
  }
}

/**
 * Scan the skills directory and update the registry.
 * Returns the number of skills registered.
 */
export function scanSkills(skillsDir: string): number {
  if (!fs.existsSync(skillsDir)) {
    logger.debug({ skillsDir }, 'Skills directory does not exist, skipping scan');
    return 0;
  }

  const entries = fs.readdirSync(skillsDir);
  let count = 0;

  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry);
    try {
      if (!fs.statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skill = scanSkillFile(fullPath, entry);
    if (!skill) continue;

    const existing = registry.get(skill.name);
    registry.set(skill.name, skill);
    count++;

    if (existing) {
      logger.info(
        { skill: skill.name, file: skill.file },
        'Skill re-registered',
      );
    } else {
      logger.info(
        { skill: skill.name, description: skill.description, file: skill.file },
        'Skill registered',
      );
    }
  }

  return count;
}

// --- Registry accessors ---

export function getRegisteredSkills(): SkillEntry[] {
  return [...registry.values()];
}

export function getSkill(name: string): SkillEntry | undefined {
  return registry.get(name);
}

// --- File watcher ---

let watcher: fs.FSWatcher | null = null;

export function watchSkills(skillsDir: string): void {
  if (!fs.existsSync(skillsDir)) return;

  try {
    watcher = fs.watch(skillsDir, { recursive: true }, (eventType, filename) => {
      // Re-scan on any change (additions, modifications, deletions)
      logger.debug(
        { eventType, filename },
        'Skills directory changed, rescanning',
      );
      scanSkills(skillsDir);
    });

    watcher.on('error', (err) => {
      logger.warn({ err }, 'Skills directory watcher error');
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to watch skills directory, falling back to scan-only');
  }
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// --- HTTP endpoint ---

let httpServer: Server | null = null;

export function startSkillServer(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    httpServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/skills') {
        const skills = getRegisteredSkills().map(
          ({ name, description, file, registeredAt }) => ({
            name,
            description,
            file,
            registeredAt,
          }),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(skills));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      logger.info({ port, host }, 'Skill registry server started');
      resolve(httpServer!);
    });
  });
}

export function stopSkillServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

// --- Initialization helper ---

const DEFAULT_SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const SKILL_SERVER_PORT = parseInt(process.env.SKILL_SERVER_PORT || '3002', 10);

/**
 * Initialize the skill registry: scan, watch, and optionally start HTTP server.
 */
export async function initSkillRegistry(
  skillsDir = DEFAULT_SKILLS_DIR,
  opts: { serve?: boolean; port?: number; host?: string } = {},
): Promise<Server | null> {
  const count = scanSkills(skillsDir);
  logger.info({ count, skillsDir }, 'Initial skill scan complete');

  watchSkills(skillsDir);

  if (opts.serve !== false) {
    const port = opts.port ?? SKILL_SERVER_PORT;
    const host = opts.host ?? '127.0.0.1';
    return startSkillServer(port, host);
  }

  return null;
}

/**
 * Clean up watchers and servers.
 */
export function shutdownSkillRegistry(): void {
  stopWatcher();
  stopSkillServer();
}

/** @internal — exported for testing */
export function _resetForTesting(): void {
  registry.clear();
  stopWatcher();
  stopSkillServer();
}
