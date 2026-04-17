import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { ExtractedFact } from './schema.js';

export interface AppendFactsInput {
  groupsRoot: string;
  groupName: string;
  threadId: string;
  account: string;
  classificationId: string;
  subject: string;
  sender: string;
  facts: ExtractedFact[];
}

/**
 * Append extracted facts to the group's knowledge.md and ingest into the
 * cross-group knowledge store (FTS5 + optional Qdrant vector).
 *
 * No-op if facts is empty. Knowledge-store ingest errors are swallowed
 * (non-fatal); the markdown append is the source of truth.
 */
export async function appendExtractedFacts(
  input: AppendFactsInput,
): Promise<void> {
  if (input.facts.length === 0) return;

  const dir = path.join(input.groupsRoot, input.groupName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'knowledge.md');

  const ts = new Date().toISOString();
  const lines = [
    ``,
    `## ${ts} — ${input.subject}`,
    `- **From:** ${input.sender}`,
    `- **Thread:** \`${input.threadId}\` · account \`${input.account}\` · classification \`${input.classificationId}\``,
    ...input.facts.map(
      (f) => `- **${f.key}:** ${f.value}  _(${f.source_span})_`,
    ),
  ];
  fs.appendFileSync(file, lines.join('\n') + '\n');

  try {
    const { storeFactWithVector } =
      await import('../memory/knowledge-store.js');
    const factText = input.facts.map((f) => `${f.key}: ${f.value}`).join('; ');
    await storeFactWithVector({
      text: `[email:${input.subject}] ${factText} (from ${input.sender}, thread ${input.threadId}, account ${input.account})`,
      domain: 'email',
      groupId: input.groupName,
      source: `triage:${input.classificationId}`,
    });
  } catch (err) {
    logger.warn(
      { err: String(err) },
      'Triage: knowledge ingest failed (non-fatal)',
    );
  }
}
