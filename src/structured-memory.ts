/**
 * Structured Memory — categorized knowledge storage.
 *
 * Splits memory into domain files:
 * - knowledge/operational.md — configs, processes, how things work
 * - knowledge/people.md — user preferences, names, relationships
 * - knowledge/incidents.md — past failures, lessons learned
 * - knowledge/decisions.md — key decisions and reasoning
 *
 * No LLM calls. Append-only writes with credential scrubbing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { MemoryEntrySchema } from './schemas.js';
import type { MemoryEntry } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DOMAINS = [
  'operational',
  'people',
  'incidents',
  'decisions',
] as const;
export type Domain = (typeof DOMAINS)[number];

const DOMAIN_FILES: Record<Domain, string> = {
  operational: 'operational.md',
  people: 'people.md',
  incidents: 'incidents.md',
  decisions: 'decisions.md',
};

const DOMAIN_HEADERS: Record<Domain, string> = {
  operational:
    '# Operational Knowledge\n\nConfigs, processes, how things work.\n',
  people: '# People\n\nUser preferences, names, relationships.\n',
  incidents: '# Incidents\n\nPast failures, lessons learned.\n',
  decisions: '# Decisions\n\nKey decisions and their reasoning.\n',
};

const MAX_FILE_SIZE = 200 * 1024; // 200 KB per domain file
const MAX_ENTRY_LENGTH = 5000; // chars per entry content

// ---------------------------------------------------------------------------
// Credential scrubbing (shared pattern)
// ---------------------------------------------------------------------------

function scrubCredentials(text: string): string {
  return text
    .replace(/\bghp_[a-zA-Z0-9]+/g, 'ghp_***')
    .replace(/\bAKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/\bxoxb-[a-zA-Z0-9_-]+/g, 'xoxb-***')
    .replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
    .replace(/\bpk-[a-zA-Z0-9_-]{10,}/g, 'pk-***')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, '$1***')
    .replace(
      /(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi,
      '$1=***',
    );
}

// ---------------------------------------------------------------------------
// Entry serialization
// ---------------------------------------------------------------------------

function entryToMarkdown(entry: MemoryEntry): string {
  const dateStr = entry.timestamp || new Date().toISOString().split('T')[0];
  return [`## ${dateStr} \u2014 ${entry.source}`, '', entry.content, ''].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Resolve the knowledge directory path for a group.
 */
async function resolveKnowledgeDir(groupFolder: string): Promise<string> {
  const { resolveGroupFolderPath } = await import('./group-folder.js');
  const groupPath = resolveGroupFolderPath(groupFolder);
  return path.join(groupPath, 'knowledge');
}

/**
 * Write a memory entry to the appropriate domain file.
 * Validates against MemoryEntrySchema, scrubs credentials, appends.
 */
export async function writeMemoryEntry(
  groupFolder: string,
  entry: MemoryEntry,
): Promise<boolean> {
  try {
    // Validate
    const parsed = MemoryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn(
        { errors: parsed.error.issues },
        'Structured memory: invalid entry rejected',
      );
      return false;
    }

    const validEntry = parsed.data;
    const domain = validEntry.category as Domain;

    if (!DOMAINS.includes(domain)) {
      logger.warn({ category: domain }, 'Structured memory: unknown category');
      return false;
    }

    // Truncate content
    validEntry.content = validEntry.content.slice(0, MAX_ENTRY_LENGTH);

    // Scrub credentials
    validEntry.content = scrubCredentials(validEntry.content);

    // Resolve path
    const knowledgeDir = await resolveKnowledgeDir(groupFolder);
    const filePath = path.join(knowledgeDir, DOMAIN_FILES[domain]);

    // Check file size cap
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size >= MAX_FILE_SIZE) {
          logger.warn(
            { filePath, size: stat.size, maxSize: MAX_FILE_SIZE },
            'Structured memory: domain file exceeds 200KB, skipping',
          );
          return false;
        }
      } catch {
        // proceed
      }
    }

    // Ensure directory exists
    fs.mkdirSync(knowledgeDir, { recursive: true });

    // Serialize
    const markdown = entryToMarkdown(validEntry);

    // Append (or create with header)
    if (fs.existsSync(filePath)) {
      fs.appendFileSync(filePath, '\n' + markdown, 'utf-8');
    } else {
      fs.writeFileSync(
        filePath,
        DOMAIN_HEADERS[domain] + '\n' + markdown,
        'utf-8',
      );
    }

    logger.info(
      { groupFolder, domain, source: validEntry.source },
      'Structured memory: entry written',
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'Structured memory: write failed');
    return false;
  }
}

/**
 * Read a specific memory domain file.
 * Returns the file contents, or empty string if not found.
 */
export async function readMemoryDomain(
  groupFolder: string,
  category: Domain,
): Promise<string> {
  try {
    const knowledgeDir = await resolveKnowledgeDir(groupFolder);
    const filePath = path.join(knowledgeDir, DOMAIN_FILES[category]);

    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.error({ err, category }, 'Structured memory: read failed');
    return '';
  }
}

/**
 * Read all memory domains. Returns a map of domain → content.
 */
export async function readAllMemory(
  groupFolder: string,
): Promise<Record<Domain, string>> {
  const result = {} as Record<Domain, string>;
  for (const domain of DOMAINS) {
    result[domain] = await readMemoryDomain(groupFolder, domain);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

/** Heuristic patterns for categorizing existing memory content. */
const CATEGORY_PATTERNS: Record<Domain, RegExp[]> = {
  operational: [
    /\b(config|deploy|cron|server|port|database|docker|container|env|process)\b/i,
    /\b(setup|install|build|compile|update|restart|migrate)\b/i,
  ],
  people: [
    /\b(prefer|name|birthday|likes|dislikes|contact|email|phone)\b/i,
    /\b(user|person|team|member|manager|friend|family)\b/i,
  ],
  incidents: [
    /\b(error|fail|crash|bug|outage|downtime|broke|issue|problem)\w*/i,
    /\b(incident|postmortem|root cause|fix|resolved|hotfix|leak)\w*/i,
  ],
  decisions: [
    /\b(decided|decision|chose|picked|went with|agreed|approved)\b/i,
    /\b(trade-?off|rationale|reason|because|alternative|option)\b/i,
  ],
};

/**
 * Categorize a text block by matching against heuristic patterns.
 * Returns the best-matching domain, defaulting to 'operational'.
 */
export function categorizeContent(text: string): Domain {
  let bestDomain: Domain = 'operational';
  let bestScore = 0;

  for (const domain of DOMAINS) {
    let score = 0;
    for (const pattern of CATEGORY_PATTERNS[domain]) {
      const matches = text.match(new RegExp(pattern, 'gi'));
      if (matches) score += matches.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

/**
 * Migrate a single memory file to structured domain files.
 * Splits content by ## headings, categorizes each section,
 * writes to appropriate domain file.
 *
 * Does NOT delete the source file (caller decides).
 * Returns count of entries migrated per domain.
 */
export async function migrateFromSingleFile(
  groupFolder: string,
  sourceFilePath: string,
): Promise<Record<Domain, number>> {
  const counts: Record<Domain, number> = {
    operational: 0,
    people: 0,
    incidents: 0,
    decisions: 0,
  };

  try {
    if (!fs.existsSync(sourceFilePath)) {
      logger.info(
        { sourceFilePath },
        'Structured memory: source file not found, nothing to migrate',
      );
      return counts;
    }

    const content = fs.readFileSync(sourceFilePath, 'utf-8');
    if (!content.trim()) return counts;

    // Split by ## headings
    const sections = content.split(/^(?=## )/m).filter((s) => s.trim());

    const now = new Date().toISOString();

    for (const section of sections) {
      const trimmed = section.trim();
      if (
        !trimmed ||
        (trimmed.startsWith('# ') && !trimmed.startsWith('## '))
      ) {
        continue; // skip top-level headers
      }

      const category = categorizeContent(trimmed);
      const entry: MemoryEntry = {
        category,
        content: trimmed.slice(0, MAX_ENTRY_LENGTH),
        source: 'migration',
        timestamp: now,
      };

      const written = await writeMemoryEntry(groupFolder, entry);
      if (written) counts[category]++;
    }

    logger.info(
      { groupFolder, sourceFilePath, counts },
      'Structured memory: migration complete',
    );
  } catch (err) {
    logger.error({ err }, 'Structured memory: migration failed');
  }

  return counts;
}
