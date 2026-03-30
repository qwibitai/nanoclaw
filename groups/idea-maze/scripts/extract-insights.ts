/**
 * Insight extraction — extracts typed insights from unprocessed source items.
 *
 * Two-tier strategy:
 * 1. LLM extraction (primary) — uses Claude via Anthropic API
 * 2. Heuristic fallback — keyword matching when LLM unavailable
 *
 * Usage: tsx extract-insights.ts [--limit N]
 */

import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { getUnprocessedItems, type SourceItemRow } from "./lib/queries.ts";
import { isLlmConfigured, generateBatchJson, EXTRACTION_BATCH_SIZE } from "./lib/llm.ts";
import { HARVEST_SYSTEM_PROMPT, buildBatchHarvestUserPrompt } from "./lib/prompts.ts";

// --- Types ---

type InsightType =
  | "pain_point"
  | "demand_signal"
  | "workflow_gap"
  | "distribution_clue"
  | "willingness_to_pay"
  | "competitor_move"
  | "implementation_constraint";

interface InsightPayload {
  source_item_id: number;
  insight_type: InsightType;
  summary: string;
  evidence_score: number;
  confidence: number;
  metadata_json: Record<string, any>;
}

interface LlmInsightBatch {
  insights: Array<{
    insight_type: InsightType;
    summary: string;
    evidence_score: number;
    confidence: number;
    metadata_json: Record<string, any>;
  }>;
}

// --- Heuristic keyword map ---

const KEYWORD_MAP: Record<InsightType, Set<string>> = {
  pain_point: new Set(["pain", "annoying", "problem", "friction", "manual", "hate"]),
  demand_signal: new Set(["need", "looking", "request", "want", "demand"]),
  workflow_gap: new Set(["workflow", "process", "automation", "repetitive", "repeat"]),
  distribution_clue: new Set(["channel", "reach", "distribution", "audience", "community"]),
  willingness_to_pay: new Set(["price", "pricing", "budget", "pay", "purchase"]),
  competitor_move: new Set(["competitor", "launch", "released", "acquired", "feature"]),
  implementation_constraint: new Set(["integration", "security", "latency", "compliance", "technical"]),
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "has", "have", "had", "not", "they", "we", "you", "he", "she",
  "its", "my", "our", "your", "their", "can", "will", "just", "don",
  "should", "now", "than", "then", "also", "into", "been", "being",
  "some", "what", "when", "where", "which", "who", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "like", "about",
  "would", "could", "there", "these", "those", "over", "such",
]);

function topKeywords(texts: string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
    for (const token of tokens) {
      if (!STOP_WORDS.has(token)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function harvestScoreFromMeta(metaStr: string): number {
  try {
    const meta = JSON.parse(metaStr);
    return Number(meta.harvest_score) || 0;
  } catch {
    return 0;
  }
}

// --- Summary templates ---

function summaryFor(type: InsightType, title: string, text: string): string {
  const context = (title || text.slice(0, 120)).slice(0, 180);
  const templates: Record<InsightType, string> = {
    pain_point: `Clear user friction or pain point mentioned: ${context}`,
    demand_signal: `Concrete signal of demand or request: ${context}`,
    workflow_gap: `Workflow inefficiency that could be productized: ${context}`,
    distribution_clue: `Potential acquisition or distribution clue: ${context}`,
    willingness_to_pay: `Pricing or willingness-to-pay signal: ${context}`,
    competitor_move: `Competitor activity worth monitoring: ${context}`,
    implementation_constraint: `Implementation constraint or operational caveat: ${context}`,
  };
  return templates[type];
}

// --- Extraction strategies ---

interface LlmBatchResponse {
  items: Array<{ index: number; insights: LlmInsightBatch["insights"] }>;
}

async function llmBatchInsights(items: SourceItemRow[]): Promise<Map<number, InsightPayload[]>> {
  const batchInput = items.map((item, i) => ({
    index: i,
    source: item.source,
    channel_or_label: item.channel_or_label,
    title: item.title ?? "",
    text: item.text,
    harvest_score: harvestScoreFromMeta(item.metadata_json),
  }));

  const prompt = buildBatchHarvestUserPrompt(batchInput);
  const result = await generateBatchJson<LlmBatchResponse>(HARVEST_SYSTEM_PROMPT, prompt);

  const out = new Map<number, InsightPayload[]>();
  for (const entry of result.items ?? []) {
    const item = items[entry.index];
    if (!item) continue;
    const harvestScore = harvestScoreFromMeta(item.metadata_json);
    out.set(entry.index, (entry.insights ?? []).map((gen) => ({
      source_item_id: item.id,
      insight_type: gen.insight_type,
      summary: gen.summary,
      evidence_score: Math.min(1.0, Math.round((gen.evidence_score + harvestScore * 0.15) * 100) / 100),
      confidence: gen.confidence,
      metadata_json: {
        strategy: "llm",
        flow: "harvest",
        source_harvest_score: harvestScore,
        ...gen.metadata_json,
      },
    })));
  }
  return out;
}

function heuristicInsights(item: SourceItemRow): InsightPayload[] {
  const harvestScore = harvestScoreFromMeta(item.metadata_json);
  const lowered = `${item.title ?? ""}\n${item.text}`.toLowerCase();
  const insights: InsightPayload[] = [];

  for (const [insightType, keywords] of Object.entries(KEYWORD_MAP) as [InsightType, Set<string>][]) {
    let matches = 0;
    for (const kw of keywords) {
      if (lowered.includes(kw)) matches++;
    }
    if (matches === 0) continue;

    const baseScore = Math.min(1.0, Math.round((0.2 + matches * 0.15) * 100) / 100);
    const weightedScore = Math.min(1.0, Math.round((baseScore + harvestScore * 0.2) * 100) / 100);

    insights.push({
      source_item_id: item.id,
      insight_type: insightType,
      summary: summaryFor(insightType, item.title ?? "", item.text),
      evidence_score: weightedScore,
      confidence: 0.55,
      metadata_json: { strategy: "heuristic", source_harvest_score: harvestScore },
    });
  }

  if (insights.length > 0) return insights;

  // Fallback: extract top keywords and create a generic demand signal
  const keywords = topKeywords([item.title ?? "", item.text], 3);
  if (!keywords.length) return [];

  return [
    {
      source_item_id: item.id,
      insight_type: "demand_signal",
      summary: `Potential demand signal around ${keywords.join(" / ")}.`,
      evidence_score: Math.min(1.0, Math.round((0.35 + harvestScore * 0.15) * 100) / 100),
      confidence: 0.3,
      metadata_json: { strategy: "fallback", keywords, source_harvest_score: harvestScore },
    },
  ];
}

// --- Main ---

async function main() {
  const db = getDb();
  initSchema(db);

  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) || 50 : 50;

  const items = getUnprocessedItems(limit);
  if (!items.length) {
    console.log("No unprocessed source items found.");
    closeDb();
    return;
  }

  const PARALLEL_BATCHES = 3;
  console.log(`Processing ${items.length} unprocessed source items...`);
  const useLlm = isLlmConfigured();
  console.log(`Strategy: ${useLlm ? `LLM batch (size=${EXTRACTION_BATCH_SIZE}, parallel=${PARALLEL_BATCHES})` : "heuristic only"}`);

  const insertInsight = db.prepare(`
    INSERT INTO insights (source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
    VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
  `);

  let totalCreated = 0;

  if (useLlm) {
    // Split into batches
    const batches: SourceItemRow[][] = [];
    for (let i = 0; i < items.length; i += EXTRACTION_BATCH_SIZE) {
      batches.push(items.slice(i, i + EXTRACTION_BATCH_SIZE));
    }

    // Process batches with limited parallelism
    for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
      const chunk = batches.slice(i, i + PARALLEL_BATCHES);
      const results = await Promise.all(
        chunk.map((batch) =>
          llmBatchInsights(batch).catch((err) => {
            console.warn(`  Batch failed, falling back to heuristics: ${err}`);
            const fallback = new Map<number, InsightPayload[]>();
            batch.forEach((item, idx) => fallback.set(idx, heuristicInsights(item)));
            return fallback;
          }),
        ),
      );

      for (let b = 0; b < chunk.length; b++) {
        const batch = chunk[b];
        const resultMap = results[b];
        for (let idx = 0; idx < batch.length; idx++) {
          const item = batch[idx];
          const payloads = resultMap.get(idx) ?? heuristicInsights(item);
          for (const p of payloads) {
            insertInsight.run(
              p.source_item_id, p.insight_type, p.summary,
              p.evidence_score, p.confidence,
              JSON.stringify(p.metadata_json), new Date().toISOString(),
            );
            totalCreated++;
          }
          if (payloads.length) {
            process.stdout.write(`  Item ${item.id}: ${payloads.length} insight(s) [${payloads.map((p) => p.insight_type).join(", ")}]\n`);
          }
        }
      }
      console.log(`  Batches ${i + 1}-${Math.min(i + PARALLEL_BATCHES, batches.length)} / ${batches.length} done`);
    }
  } else {
    for (const item of items) {
      const payloads = heuristicInsights(item);
      for (const p of payloads) {
        insertInsight.run(
          p.source_item_id, p.insight_type, p.summary,
          p.evidence_score, p.confidence,
          JSON.stringify(p.metadata_json), new Date().toISOString(),
        );
        totalCreated++;
      }
      if (payloads.length) {
        console.log(`  Item ${item.id}: ${payloads.length} insight(s) [${payloads.map((p) => p.insight_type).join(", ")}]`);
      }
    }
  }

  console.log(`\nDone. Created ${totalCreated} insights from ${items.length} source items.`);
  closeDb();
}

main().catch((err) => {
  console.error("Insight extraction failed:", err);
  process.exit(1);
});
