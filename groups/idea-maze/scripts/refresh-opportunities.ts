/**
 * Opportunity clustering — groups recent insights into opportunities.
 *
 * Ported from idea-maze-lab OpportunityService.refresh().
 * Clusters insights by top keyword, scores by weighted evidence,
 * and maintains opportunity_sources links.
 *
 * Usage: tsx refresh-opportunities.ts
 */

import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";

// --- Helpers ---

const STOP_WORDS = new Set([
  // Articles, conjunctions, prepositions
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "into", "over", "such", "per",
  // Pronouns
  "it", "its", "they", "we", "you", "he", "she", "my", "our", "your",
  "their", "this", "that", "these", "those", "there", "who", "which",
  "what", "when", "where", "how",
  // Common verbs
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "do", "does", "did", "get", "gets", "got", "use", "uses", "used",
  "make", "made", "need", "needs", "want", "wants", "can", "will",
  "would", "could", "should", "may", "might", "let", "set", "run",
  // Common adverbs / filler
  "not", "just", "now", "than", "then", "also", "very", "more", "most",
  "some", "any", "all", "each", "every", "both", "few", "often",
  "still", "even", "only", "about", "like", "well", "already", "always",
  "never", "really", "quite", "rather", "much", "many",
  // Common generic adjectives
  "good", "new", "old", "big", "small", "large", "great", "high", "low",
  "long", "short", "same", "other", "own", "right", "next", "last",
  "little", "general", "clear", "actual", "certain", "free", "full",
  "able", "due", "real", "early", "easy", "hard", "simple", "true",
  "open", "public", "specific", "best", "better", "worse", "common",
  "around", "concrete", "actual", "honest", "boring", "genuine",
  "blind", "conscious", "brief", "correct", "dark", "direct", "done",
  // Pipeline template words
  "signal", "signals", "potential", "demand", "clue", "mentioned",
  "productized", "monitoring", "point", "constraint", "caveat",
  "opportunity", "insight", "around", "pricing",
]);

function topKeywords(texts: string[], limit = 2): string[] {
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "untitled-opportunity";
}

function harvestScoreFromMeta(metaStr: string): number {
  try {
    return Number(JSON.parse(metaStr).harvest_score) || 0;
  } catch {
    return 0;
  }
}

// --- Main ---

function main() {
  const db = getDb();
  initSchema(db);

  // Fetch recent insights with their source items
  const insights = db.prepare(`
    SELECT i.*, si.source as si_source, si.title as si_title, si.text as si_text,
           si.metadata_json as si_metadata_json
    FROM insights i
    JOIN source_items si ON si.id = i.source_item_id
    ORDER BY i.created_at_utc DESC
    LIMIT 500
  `).all() as any[];

  if (!insights.length) {
    console.log("No insights to cluster.");
    closeDb();
    return;
  }

  console.log(`Clustering ${insights.length} recent insights...`);

  // Group by top keyword extracted from source item text (more content than summary)
  const clusters = new Map<string, any[]>();
  for (const insight of insights) {
    const sourceText = `${insight.si_title ?? ""} ${insight.si_text ?? ""}`;
    const keywords = topKeywords([sourceText, insight.summary], 3);
    const clusterKey = keywords[0] ?? insight.insight_type;
    if (!clusters.has(clusterKey)) clusters.set(clusterKey, []);
    clusters.get(clusterKey)!.push(insight);
  }

  console.log(`Found ${clusters.size} clusters.`);

  const now = new Date().toISOString();
  const upsertOpp = db.prepare(`
    INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      thesis = excluded.thesis,
      score = excluded.score,
      cluster_key = excluded.cluster_key,
      metadata_json = excluded.metadata_json,
      updated_at_utc = excluded.updated_at_utc
  `);

  const linkSource = db.prepare(`
    INSERT OR IGNORE INTO opportunity_sources (opportunity_id, source_item_id)
    VALUES (?, ?)
  `);

  const getOppId = db.prepare("SELECT id FROM opportunities WHERE slug = ?");

  let created = 0;

  // Filter out small / single-type clusters
  const MIN_INSIGHTS = 3;
  const filteredClusters = [...clusters.entries()].filter(
    ([, items]) => items.length >= MIN_INSIGHTS,
  );

  console.log(`Found ${clusters.size} raw clusters, ${filteredClusters.length} with ≥${MIN_INSIGHTS} insights.`);

  for (const [clusterKey, clusterInsights] of filteredClusters) {
    // Rank insights by evidence_score + harvest_score
    const ranked = clusterInsights.sort((a: any, b: any) => {
      const scoreA = a.evidence_score + harvestScoreFromMeta(a.si_metadata_json);
      const scoreB = b.evidence_score + harvestScoreFromMeta(b.si_metadata_json);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return (b.created_at_utc ?? "").localeCompare(a.created_at_utc ?? "");
    });

    // Build bigram title from combined text of all insights in cluster
    const allText = ranked.map((i: any) => `${i.si_title ?? ""} ${i.si_text ?? ""} ${i.summary}`).join(" ");
    const topWords = topKeywords([allText], 3);
    const bigramLabel = topWords.slice(0, 2).join("-") || clusterKey;
    const title = bigramLabel.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const slug = slugify(title);
    const thesis = ranked[0].summary;

    // Compute scores
    const sourceScores = ranked.map((i: any) => harvestScoreFromMeta(i.si_metadata_json));
    const avgSourceScore = sourceScores.length ? sourceScores.reduce((a: number, b: number) => a + b, 0) / sourceScores.length : 0;
    const uniqueSources = new Set(ranked.map((i: any) => i.si_source)).size;

    const weightedEvidence = ranked.reduce((sum: number, i: any) => {
      const hs = harvestScoreFromMeta(i.si_metadata_json);
      return sum + i.evidence_score * (1.0 + hs * 0.75);
    }, 0);

    const score = Math.round(
      Math.min(10.0, weightedEvidence + avgSourceScore * 2.5 + uniqueSources * 0.4 + ranked.length * 0.2) * 100,
    ) / 100;

    // Collect pattern/signal counts
    const patternCounts = new Map<string, number>();
    const signalCounts = new Map<string, number>();
    for (const i of ranked) {
      try {
        const meta = JSON.parse(i.si_metadata_json);
        for (const p of meta.source_patterns ?? []) patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
        for (const s of meta.harvest_signals ?? []) signalCounts.set(s, (signalCounts.get(s) ?? 0) + 1);
      } catch { /* skip */ }
    }

    const metadata = {
      insight_count: ranked.length,
      source_count: uniqueSources,
      highlights: ranked.slice(0, 5).map((i: any) => i.summary),
      average_harvest_score: Math.round(avgSourceScore * 1000) / 1000,
      top_source_patterns: [...patternCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n),
      top_harvest_signals: [...signalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
    };

    upsertOpp.run(slug, title, thesis, score, clusterKey, JSON.stringify(metadata), now, now);

    // Link source items
    const opp = getOppId.get(slug) as { id: number } | undefined;
    if (opp) {
      const seenSources = new Set<number>();
      for (const i of ranked) {
        if (!seenSources.has(i.source_item_id)) {
          linkSource.run(opp.id, i.source_item_id);
          seenSources.add(i.source_item_id);
        }
      }
    }

    console.log(`  ${slug}: score=${score}, insights=${ranked.length}, sources=${uniqueSources}`);
    created++;
  }

  console.log(`\nDone. ${created} opportunities created/updated.`);
  closeDb();
}

main();
