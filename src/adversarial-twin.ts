import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getDb } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface TwinConfig {
  enabled: boolean;
  minPromptLength?: number;
}

export interface AdversarialTranscript {
  id: number;
  group_folder: string;
  original_prompt: string;
  main_response: string;
  rebuttal: string | null;
  final_response: string | null;
  created_at: string;
}

/**
 * Reads the adversarial twin configuration for a group.
 * Returns { enabled: false } if the config file is missing or malformed.
 */
export function getTwinConfig(groupFolder: string): TwinConfig {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'adversarial-twin.json');
  try {
    if (!fs.existsSync(configPath)) {
      return { enabled: false, minPromptLength: 200 };
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TwinConfig;
    return parsed;
  } catch {
    return { enabled: false, minPromptLength: 200 };
  }
}

/**
 * Build a prompt for the skeptic agent to critique the main agent's response.
 */
export function buildSkepticPrompt(
  originalPrompt: string,
  mainResponse: string,
): string {
  return `You are a critical reviewer. Your job is to find flaws, risks, and missing considerations in an AI agent's response.

## Original task/prompt

${originalPrompt}

## Main agent's response

${mainResponse}

## Your task

Review the response above and identify specific problems. Be concise. List 2-5 specific issues such as:
- Incorrect assumptions
- Missing edge cases or error handling
- Security or safety risks
- Incomplete or misleading information
- Logical errors or contradictions

Focus on actionable, concrete issues only.`;
}

/**
 * Build an augmented prompt giving the main agent the skeptic's critique so it can revise.
 */
export function buildAugmentedPrompt(
  originalPrompt: string,
  mainResponse: string,
  rebuttal: string,
): string {
  return `You previously responded to a task. A skeptic reviewed your response and found issues. Please revise your response addressing these concerns.

## Original task

${originalPrompt}

## Your previous response

${mainResponse}

## Skeptic review

A skeptic reviewed your response and found:

${rebuttal}

Please revise your response addressing these concerns. Provide a complete, improved response.`;
}

/**
 * Save an adversarial transcript to the database. Returns the new row ID.
 */
export function saveAdversarialTranscript(
  groupFolder: string,
  originalPrompt: string,
  mainResponse: string,
  rebuttal: string | null,
  finalResponse: string | null,
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO adversarial_transcripts
         (group_folder, original_prompt, main_response, rebuttal, final_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(groupFolder, originalPrompt, mainResponse, rebuttal, finalResponse, now);
  return result.lastInsertRowid as number;
}

/**
 * Retrieve adversarial transcripts for a group, newest first.
 */
export function getAdversarialTranscripts(
  groupFolder: string,
  limit?: number,
): AdversarialTranscript[] {
  const db = getDb();
  if (limit !== undefined) {
    return db
      .prepare(
        `SELECT * FROM adversarial_transcripts
         WHERE group_folder = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(groupFolder, limit) as AdversarialTranscript[];
  }
  return db
    .prepare(
      `SELECT * FROM adversarial_transcripts
       WHERE group_folder = ?
       ORDER BY created_at DESC`,
    )
    .all(groupFolder) as AdversarialTranscript[];
}

/**
 * Stub for adversarial twin execution.
 *
 * The actual container spawning logic lives in index.ts, which calls
 * buildSkepticPrompt / buildAugmentedPrompt directly. This function
 * provides the gating logic (config check, prompt length check) and
 * saves a stub transcript, returning null in all cases.
 */
export async function runAdversarialTwin(
  group: RegisteredGroup,
  originalPrompt: string,
  mainResponse: string,
  queue: GroupQueue,
): Promise<string | null> {
  const config = getTwinConfig(group.folder);

  if (!config.enabled) {
    logger.debug(
      { groupFolder: group.folder },
      'Adversarial twin disabled for group',
    );
    return null;
  }

  const minLength = config.minPromptLength ?? 200;
  if (originalPrompt.length < minLength) {
    logger.debug(
      { groupFolder: group.folder, promptLength: originalPrompt.length, minLength },
      'Prompt too short for adversarial twin, skipping',
    );
    return null;
  }

  logger.info(
    { groupFolder: group.folder },
    'Adversarial twin would run for group ' + group.folder,
  );

  // Save a stub transcript — actual container integration is in index.ts
  saveAdversarialTranscript(group.folder, originalPrompt, mainResponse, null, null);

  return null;
}
