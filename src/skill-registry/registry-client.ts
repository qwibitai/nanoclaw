/**
 * Registry Client
 *
 * Fetches skill registries from GitHub-hosted marketplaces,
 * caches locally, and provides search/lookup operations.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { SkillRegistrySchema } from './schema.js';
import type {
  MarketplaceSource,
  SkillMetadata,
  SkillRegistry,
} from './types.js';
import { logger } from '../logger.js';

const CACHE_DIR = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'skill-cache',
);
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Default official marketplace. */
export const OFFICIAL_MARKETPLACE: MarketplaceSource = {
  id: 'nanoclaw-skills',
  name: 'NanoClaw Official',
  repo: 'qwibitai/nanoclaw-skills',
  branch: 'main',
  registryPath: 'registry.json',
  official: true,
};

function getCachePath(source: MarketplaceSource): string {
  return path.join(CACHE_DIR, `${source.id}.json`);
}

function isCacheValid(cachePath: string): boolean {
  try {
    const stat = fs.statSync(cachePath);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Fetch a registry from a GitHub marketplace repo.
 * Uses the GitHub raw content API (no auth required for public repos).
 */
export async function fetchRegistry(
  source: MarketplaceSource,
): Promise<SkillRegistry | null> {
  const cachePath = getCachePath(source);

  // Check cache first
  if (isCacheValid(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const parsed = SkillRegistrySchema.parse(cached);
      return parsed;
    } catch {
      // Cache corrupted, fetch fresh
    }
  }

  const branch = source.branch || 'main';
  const registryPath = source.registryPath || 'registry.json';
  const url = `https://raw.githubusercontent.com/${source.repo}/${branch}/${registryPath}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { source: source.id, status: response.status },
        'Failed to fetch skill registry',
      );
      return null;
    }

    const data = await response.json();
    const registry = SkillRegistrySchema.parse(data);

    // Cache the result
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(registry, null, 2));

    return registry;
  } catch (err) {
    logger.warn({ source: source.id, err }, 'Error fetching skill registry');
    return null;
  }
}

/**
 * Load all configured marketplace sources.
 * Reads from .claude/settings.json extraKnownMarketplaces.
 */
export function loadMarketplaceSources(): MarketplaceSource[] {
  const sources: MarketplaceSource[] = [OFFICIAL_MARKETPLACE];

  try {
    const settingsPath = path.join(
      process.cwd(),
      '.claude',
      'settings.json',
    );
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const marketplaces = settings?.extraKnownMarketplaces;
      if (marketplaces && typeof marketplaces === 'object') {
        for (const [id, config] of Object.entries(marketplaces)) {
          if (id === OFFICIAL_MARKETPLACE.id) continue; // Skip duplicate
          const cfg = config as { source?: { repo?: string } };
          if (cfg?.source?.repo) {
            sources.push({
              id,
              name: id,
              repo: cfg.source.repo,
              official: false,
            });
          }
        }
      }
    }
  } catch {
    // Settings not found or invalid — use defaults only
  }

  return sources;
}

/**
 * Fetch all registries from all configured marketplace sources.
 */
export async function fetchAllRegistries(): Promise<
  Map<string, SkillRegistry>
> {
  const sources = loadMarketplaceSources();
  const registries = new Map<string, SkillRegistry>();

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const registry = await fetchRegistry(source);
      if (registry) {
        registries.set(source.id, registry);
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ err: result.reason }, 'Failed to fetch a registry');
    }
  }

  return registries;
}

/**
 * Get all skills across all registries.
 */
export async function getAllSkills(): Promise<
  Array<SkillMetadata & { source: string }>
> {
  const registries = await fetchAllRegistries();
  const skills: Array<SkillMetadata & { source: string }> = [];

  for (const [sourceId, registry] of registries) {
    for (const skill of registry.skills) {
      skills.push({ ...skill, source: sourceId });
    }
  }

  return skills;
}

/**
 * Search skills by query string.
 * Matches against name, displayName, description, and tags.
 */
export async function searchSkills(
  query: string,
): Promise<Array<SkillMetadata & { source: string }>> {
  const allSkills = await getAllSkills();
  const lowerQuery = query.toLowerCase();

  return allSkills.filter((skill) => {
    const searchableText = [
      skill.name,
      skill.displayName,
      skill.description,
      ...skill.tags,
    ]
      .join(' ')
      .toLowerCase();
    return searchableText.includes(lowerQuery);
  });
}

/**
 * Find a specific skill by name across all registries.
 */
export async function findSkill(
  name: string,
): Promise<(SkillMetadata & { source: string }) | null> {
  const allSkills = await getAllSkills();
  return allSkills.find((s) => s.name === name) || null;
}

/**
 * Clear the registry cache.
 */
export function clearCache(): void {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clear skill cache');
  }
}
