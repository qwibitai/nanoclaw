/**
 * Obsidian integration for NanoClaw
 * Provides qmd search, tag scanning, and audio persistence for the vault.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const VAULT_PATH = path.join(
  os.homedir(),
  'Obsidian',
  'pj-private-vault',
  'pj-private-vault',
);

const AUDIO_DIR = path.join(VAULT_PATH, 'attachments', 'audio');

export interface RelatedNote {
  path: string;
  excerpt: string;
}

export interface ObsidianContext {
  related_notes: RelatedNote[];
  existing_tags: string[];
  audio_file?: string;
}

/**
 * Search for related notes using qmd (if installed).
 * Returns empty array if qmd is not available.
 */
export async function searchRelatedNotes(
  query: string,
): Promise<RelatedNote[]> {
  try {
    const { stdout } = await execFileAsync(
      'qmd',
      ['search', query, '-c', 'pj-private-vault', '--files'],
      { timeout: 30_000 },
    );

    // --files output: docid,score,qmd://collection/path,"context"
    const results: RelatedNote[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      // Parse CSV-like line: docid,score,qmd://pj-private-vault/path.md,"context"
      const match = line.match(
        /^[^,]+,([^,]+),qmd:\/\/pj-private-vault\/(.+?)(?:,".*")?$/,
      );
      if (match) {
        const vaultRelPath = match[2];
        // Strip .md extension for the note name
        const noteName = vaultRelPath.replace(/\.md$/, '');
        results.push({
          path: vaultRelPath,
          excerpt: noteName,
        });
      }
    }

    return results.slice(0, 10);
  } catch (err) {
    // qmd not installed or search failed — degrade gracefully
    logger.debug({ err }, 'qmd search unavailable, skipping');
    return [];
  }
}

/**
 * Scan the vault for existing tags (from frontmatter and inline).
 * Returns deduplicated, kebab-case normalized tags.
 */
export async function getExistingTags(): Promise<string[]> {
  try {
    // Extract frontmatter tags
    const { stdout: fmTags } = await execFileAsync(
      'grep',
      [
        '-roh',
        '#[a-zA-Z0-9_/-]\\+',
        VAULT_PATH,
        '--include=*.md',
        '--exclude-dir=.obsidian',
        '--exclude-dir=attachments',
      ],
      { timeout: 10_000 },
    );

    // Also get tags from frontmatter YAML (tags: [...])
    const { stdout: yamlTags } = await execFileAsync(
      'grep',
      [
        '-rh',
        '  - [a-zA-Z]',
        VAULT_PATH,
        '--include=*.md',
        '--exclude-dir=.obsidian',
      ],
      { timeout: 10_000 },
    ).catch(() => ({ stdout: '' }));

    const tagSet = new Set<string>();

    // Parse inline tags (remove # prefix, normalize to kebab-case)
    for (const line of fmTags.split('\n')) {
      const tag = line.trim().replace(/^#/, '');
      if (tag) tagSet.add(normalizeTag(tag));
    }

    // Parse YAML list tags
    for (const line of yamlTags.split('\n')) {
      const match = line.match(/^\s+-\s+(.+)/);
      if (match) {
        const tag = match[1].trim();
        if (tag && !tag.startsWith('[') && !tag.startsWith('{')) {
          tagSet.add(normalizeTag(tag));
        }
      }
    }

    return [...tagSet].sort();
  } catch (err) {
    logger.debug({ err }, 'Tag scanning failed');
    return [];
  }
}

/**
 * Normalize a tag to kebab-case.
 */
function normalizeTag(tag: string): string {
  return tag
    .replace(/([a-z])([A-Z])/g, '$1-$2') // camelCase → camel-case
    .replace(/[_\s]+/g, '-') // underscores/spaces → hyphens
    .replace(/--+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    .toLowerCase();
}

/**
 * Generate a timestamp-based audio filename from a Date.
 * Format: YYYY-MM-DD-HHMMSS.ogg (UTC)
 * Stub: will be implemented in T004.
 */
export function generateAudioFilename(_timestamp: Date): string {
  // TODO(T004): implement timestamp-based filename generation
  return 'voice-stub.ogg';
}

/**
 * Save an audio buffer to the vault's attachments directory.
 * Returns the filename (relative to vault) for embedding.
 */
export function saveAudioToVault(
  audioBuffer: Buffer,
  messageId: string,
): string {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const filename = `voice-${messageId}.ogg`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, audioBuffer);

  logger.info({ filename, size: audioBuffer.length }, 'Audio saved to vault');
  return filename;
}

/**
 * Build the obsidian context file for the agent.
 * Written to the group's IPC directory so the agent can read it.
 */
export async function buildObsidianContext(
  query: string,
  ipcDir: string,
  audioFile?: string,
): Promise<void> {
  const [relatedNotes, existingTags] = await Promise.all([
    searchRelatedNotes(query),
    getExistingTags(),
  ]);

  const context: ObsidianContext = {
    related_notes: relatedNotes,
    existing_tags: existingTags,
    ...(audioFile && { audio_file: audioFile }),
  };

  const contextPath = path.join(ipcDir, 'obsidian_context.json');
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
  logger.info(
    {
      relatedNotes: relatedNotes.length,
      tags: existingTags.length,
      audioFile,
    },
    'Obsidian context written',
  );
}
