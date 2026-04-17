// src/memory/shared/verifier.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { generateText } from 'ai';
import { resolveUtilityModel } from '../../llm/utility.js';
import { logger } from '../../logger.js';
import { candidateDir, rejectedDir, ensureMemoryDirs } from './paths.js';
import { readFact, writeFact, regenerateIndex } from './store.js';
import { logAudit } from './audit.js';
import type {
  Candidate,
  CandidateFrontmatter,
  Fact,
  FactFrontmatter,
} from './types.js';

const MAX_HISTORY = 5;

export async function runVerifierSweep(): Promise<void> {
  if (process.env.NANOCLAW_MEMORY_VERIFY === '0') return;

  ensureMemoryDirs();
  const candidates = listCandidates();
  if (candidates.length === 0) return;

  let mutated = false;
  for (const cand of candidates) {
    try {
      const handled = await processCandidate(cand);
      if (handled) mutated = true;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          file: cand.filename,
        },
        'memory verifier: candidate processing failed',
      );
    }
  }

  if (mutated) regenerateIndex();
}

async function processCandidate(cand: Candidate): Promise<boolean> {
  // Merge path: existing fact named in proposed_action
  const action = cand.frontmatter.proposed_action;
  if (action.startsWith('merge:')) {
    const existing = readFact(action.slice('merge:'.length));
    if (existing) {
      mergeFact(existing, cand);
      removeCandidate(cand);
      logAudit({
        action: 'merge',
        slug: existing.slug,
        source: cand.frontmatter.extracted_from,
        reason: 'merge proposed_action',
      });
      return true;
    }
    // existing not found → fall through to create with quality gate
  }

  // Quality gate (Haiku)
  const verdict = await qualityGate(cand);
  if (!verdict.pass) {
    rejectCandidate(cand, verdict.reason);
    logAudit({
      action: 'reject',
      slug: slugFor(cand),
      source: cand.frontmatter.extracted_from,
      reason: verdict.reason,
    });
    return false;
  }

  // Implicit-merge: name collision with existing fact
  const slug = slugFor(cand);
  const existing = readFact(slug);
  if (existing) {
    mergeFact(existing, cand);
    removeCandidate(cand);
    logAudit({
      action: 'merge',
      slug,
      source: cand.frontmatter.extracted_from,
      reason: 'name collision',
    });
    return true;
  }

  // Promote new fact
  const now = new Date().toISOString().slice(0, 10);
  const newFact: Fact = {
    slug,
    frontmatter: {
      name: cand.frontmatter.name,
      description: cand.frontmatter.description,
      type: cand.frontmatter.type,
      scopes: cand.frontmatter.scopes,
      count: 1,
      first_seen: now,
      last_seen: now,
      sources: { [cand.frontmatter.extracted_from]: 1 },
    },
    body: cand.body,
  };
  writeFact(newFact);
  removeCandidate(cand);
  logAudit({
    action: 'create',
    slug,
    source: cand.frontmatter.extracted_from,
    reason: verdict.reason,
  });
  return true;
}

function mergeFact(existing: Fact, cand: Candidate): void {
  const fm: FactFrontmatter = { ...existing.frontmatter };
  fm.count += 1;
  fm.last_seen = new Date().toISOString().slice(0, 10);
  if (cand.frontmatter.scopes) {
    const merged = new Set([...(fm.scopes ?? []), ...cand.frontmatter.scopes]);
    fm.scopes = Array.from(merged);
  }
  const src = cand.frontmatter.extracted_from;
  fm.sources = { ...fm.sources, [src]: (fm.sources[src] ?? 0) + 1 };

  const newBody = cand.body.trim();
  if (newBody && newBody !== existing.body.trim()) {
    fm.history = [existing.body.trim(), ...(fm.history ?? [])].slice(
      0,
      MAX_HISTORY,
    );
    fm.last_value = newBody.split('\n')[0].slice(0, 80);
  }

  writeFact({
    slug: existing.slug,
    frontmatter: fm,
    body: newBody || existing.body,
  });
}

interface Verdict {
  pass: boolean;
  reason: string;
}

async function qualityGate(cand: Candidate): Promise<Verdict> {
  const model = resolveUtilityModel(
    process.env.MEMORY_VERIFY_MODEL ?? 'anthropic:claude-haiku-4-5-20251001',
  );
  const prompt = `Candidate fact:
Name: ${cand.frontmatter.name}
Type: ${cand.frontmatter.type}
Body: ${cand.body}
Source group: ${cand.frontmatter.extracted_from}
Confidence (extractor): ${cand.frontmatter.confidence}

Extracted from this turn excerpt:
${cand.frontmatter.turn_excerpt}

Is this a real, durable fact about the user, their preferences, ongoing work, or external references that would be useful in future conversations across other groups?

Return strict JSON: { "verdict": "pass" | "fail", "reason": "<one short sentence>" }
Reject if: transient state (current task progress), agent confusion, hallucination, or trivially derivable from the chat platform itself.`;

  let text: string;
  try {
    const llm = await generateText({
      model,
      system:
        'You are a careful gatekeeper for a long-term memory store. Output JSON only.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 200,
    });
    text = llm.text;
  } catch (err) {
    return {
      pass: false,
      reason: `verifier LLM error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const parsed = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, ''),
    ) as Verdict & { verdict: 'pass' | 'fail' };
    return { pass: String(parsed.verdict).toLowerCase() === 'pass', reason: parsed.reason };
  } catch {
    return { pass: false, reason: 'unparseable verifier output' };
  }
}

function listCandidates(): Candidate[] {
  ensureMemoryDirs();
  const out: Candidate[] = [];
  for (const entry of fs.readdirSync(candidateDir())) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(candidateDir(), entry);
    if (!fs.statSync(full).isFile()) continue;
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = parseFront(raw);
    if (!parsed) continue;
    out.push({
      filename: entry,
      frontmatter: parsed.frontmatter as unknown as CandidateFrontmatter,
      body: parsed.body,
    });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

function parseFront(
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const front = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  return { frontmatter: yaml.load(front) as Record<string, unknown>, body };
}

function removeCandidate(cand: Candidate): void {
  fs.unlinkSync(path.join(candidateDir(), cand.filename));
}

function rejectCandidate(cand: Candidate, reason: string): void {
  const dest = path.join(rejectedDir(), cand.filename);
  const raw = fs.readFileSync(path.join(candidateDir(), cand.filename), 'utf8');
  fs.writeFileSync(dest, `# Rejected: ${reason}\n\n${raw}`);
  fs.unlinkSync(path.join(candidateDir(), cand.filename));
}

function slugFor(cand: Candidate): string {
  const base =
    cand.frontmatter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fact';
  return `${cand.frontmatter.type}_${base}`;
}
