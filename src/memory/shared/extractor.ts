// src/memory/shared/extractor.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { generateText } from 'ai';
import { resolveUtilityModel } from '../../llm/utility.js';
import { logger } from '../../logger.js';
import { candidateDir, ensureMemoryDirs, indexPath } from './paths.js';
import type {
  CandidateFrontmatter,
  ExtractedCandidate,
  ExtractorResult,
} from './types.js';

const TRIVIAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|thank you|ty|np|ok|okay|cool|got it|nice|great|done|sure|yes|no|nope|yep|yeah)[!.?\s]*$/i,
];

// Minimum combined char length before a turn is considered for extraction.
// Turns shorter than this are trivial regardless of content.
const MIN_TURN_TOKENS = 30; // approx tokens; multiply by 4 for char estimate
const MIN_TURN_CHARS = MIN_TURN_TOKENS * 4; // 120 chars

export function isTrivialTurn(
  userMessage: string,
  agentReply: string,
): boolean {
  // Pattern check first: single-word greetings/acks are always trivial.
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(userMessage.trim())) return true;
  }
  // Short combined length with short individual messages indicates trivial chatter.
  const total = userMessage.length + agentReply.length;
  if (total < MIN_TURN_CHARS && userMessage.trim().split(/\s+/).length <= 5)
    return true;
  return false;
}

export interface ExtractInput {
  groupName: string;
  userMessage: string;
  agentReply: string;
}

export async function extractCandidates(input: ExtractInput): Promise<void> {
  if (process.env.NANOCLAW_MEMORY_EXTRACT === '0') return;
  const allowlist = (process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS ?? '').trim();
  if (allowlist) {
    const allowed = new Set(
      allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!allowed.has(input.groupName)) return;
  }
  if (isTrivialTurn(input.userMessage, input.agentReply)) return;

  ensureMemoryDirs();
  const indexSnippet = readIndexSnippet();

  let result: ExtractorResult;
  try {
    const model = resolveUtilityModel(
      process.env.MEMORY_EXTRACT_MODEL ?? 'anthropic:claude-haiku-4-5-20251001',
    );
    const llm = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildPrompt(input, indexSnippet),
        },
      ],
      maxOutputTokens: 800,
    });
    result = parseLLMOutput(llm.text);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'memory extractor: LLM call failed, skipping',
    );
    return;
  }

  for (const cand of result.candidates) {
    try {
      writeCandidate(cand, input);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          name: cand.name,
        },
        'memory extractor: failed to write candidate, skipping',
      );
    }
  }
}

function buildPrompt(input: ExtractInput, indexSnippet: string): string {
  return `Group: ${input.groupName}

Existing memory index (so you can propose merges, not duplicates):
${indexSnippet || '(empty)'}

Last user message:
${input.userMessage}

Agent reply:
${input.agentReply}

Extract any durable facts about the user, their preferences, ongoing projects, or external references that would be useful in future conversations across other groups. Return zero candidates if there is nothing durable to learn.`;
}

const SYSTEM_PROMPT = `You extract durable user facts from chat turns.

Output strict JSON only: { "candidates": [...] }

Each candidate has:
- type: one of "user" (identity facts), "feedback" (preferences/corrections), "project" (ongoing work state), "reference" (external pointers)
- name: short title (under 60 chars)
- description: one-line summary used in the index
- body: 1-3 paragraphs explaining the fact, including a "Why:" and "How to apply:" line for feedback/project types
- scopes: optional array. Use sparingly. Common values: "personal", "chat", "coding", "research", "work:whoisxml", "work:attaxion", "work:dev"
- proposed_action: "create" for a new fact, or "merge:<existing-slug>" if an entry in the index covers the same thing
- confidence: 0.0-1.0 — how sure are you this is durable signal, not transient state

Skip ephemeral things (current task progress, one-off questions, agent confusion). Skip facts already represented in the index unless you have a merge proposal that adds information.

Return { "candidates": [] } if nothing qualifies. Output JSON ONLY, no prose.`;

function parseLLMOutput(text: string): ExtractorResult {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const parsed = JSON.parse(trimmed) as ExtractorResult;
  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    return { candidates: [] };
  }
  const valid = parsed.candidates.filter(
    (c) =>
      c &&
      typeof c.type === 'string' &&
      typeof c.name === 'string' &&
      c.name.trim().length > 0 &&
      typeof c.body === 'string' &&
      c.body.trim().length > 0 &&
      typeof c.proposed_action === 'string' &&
      typeof c.confidence === 'number',
  );
  return { candidates: valid };
}

function readIndexSnippet(): string {
  if (!fs.existsSync(indexPath())) return '';
  const raw = fs.readFileSync(indexPath(), 'utf8');
  // Skip preamble; return only bullet entries (≤ 50 lines)
  return raw
    .split('\n')
    .filter((line) => line.startsWith('- ['))
    .slice(0, 50)
    .join('\n');
}

function writeCandidate(cand: ExtractedCandidate, input: ExtractInput): void {
  const slug = slugify(cand.name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${ts}-${input.groupName}-${slug}-${rand}.md`;

  const frontmatter: CandidateFrontmatter = {
    candidate: true,
    type: cand.type,
    name: cand.name,
    description: cand.description,
    scopes: cand.scopes,
    extracted_from: input.groupName,
    extracted_at: new Date().toISOString(),
    turn_excerpt: truncate(
      `USER: ${input.userMessage}\nAGENT: ${input.agentReply}`,
      600,
    ),
    proposed_action: cand.proposed_action,
    confidence: cand.confidence,
  };

  const front = yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd();
  const content = `---\n${front}\n---\n\n${cand.body.trim()}\n`;
  fs.writeFileSync(path.join(candidateDir(), filename), content);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fact'
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
