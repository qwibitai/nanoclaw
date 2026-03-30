/**
 * Research drafting — creates a research run for an opportunity.
 *
 * Loads the opportunity and linked source items, optionally enriches
 * with Tavily web search, builds a draft, and moves the run to review_gate.
 *
 * Usage: tsx research-opportunity.ts <slug-or-topic>
 */

import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { isLlmConfigured, generateResearchJson as generateJson } from "./lib/llm.ts";
import { RESEARCH_SYSTEM_PROMPT, buildResearchUserPrompt } from "./lib/prompts.ts";
import {
  enrichOpportunityWithSearch,
  isSearchConfigured,
  type SearchEvidenceItem,
} from "./lib/search.ts";

// --- Types ---

interface ResearchDraft {
  opportunity_slug: string;
  thesis: string;
  evidence_from_inbox: string[];
  evidence_from_telegram: string[];
  evidence_from_reddit: string[];
  external_market_check: string[];
  product_concept: string;
  mvp_scope: string[];
  implementation_plan: string[];
  distribution_plan: string[];
  risks: string[];
  decision_for_human_review: string;
  source_refs: number[];
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}

function harvestScoreFromMeta(metaStr: string): number {
  try { return Number(JSON.parse(metaStr).harvest_score) || 0; } catch { return 0; }
}

// --- Draft building ---

async function buildLlmDraft(
  opp: { slug: string; title: string; thesis: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
  searchAnswers: string[],
): Promise<Omit<ResearchDraft, "opportunity_slug" | "source_refs">> {
  const inbox = sourceItems.filter((s) => s.source === "gmail").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const telegram = sourceItems.filter((s) => s.source === "telegram").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const reddit = sourceItems.filter((s) => s.source === "reddit").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const external = searchItems.slice(0, 5).map((s) => s.title || s.text.slice(0, 180));

  const prompt = buildResearchUserPrompt({
    slug: opp.slug,
    title: opp.title,
    thesis: opp.thesis,
    inbox_evidence: inbox,
    telegram_evidence: telegram,
    reddit_evidence: reddit,
    external_research: external,
    search_synthesis: searchAnswers,
  });

  return generateJson<Omit<ResearchDraft, "opportunity_slug" | "source_refs">>(
    RESEARCH_SYSTEM_PROMPT,
    prompt,
  );
}

function buildTemplateDraft(
  opp: { slug: string; title: string; thesis: string; cluster_key: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
): Omit<ResearchDraft, "opportunity_slug" | "source_refs"> {
  const inbox = sourceItems.filter((s) => s.source === "gmail").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const telegram = sourceItems.filter((s) => s.source === "telegram").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const reddit = sourceItems.filter((s) => s.source === "reddit").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const external = searchItems.slice(0, 5).map((s) => s.title || s.text.slice(0, 180));

  return {
    thesis: opp.thesis,
    evidence_from_inbox: inbox.length ? inbox : ["None"],
    evidence_from_telegram: telegram.length ? telegram : ["None"],
    evidence_from_reddit: reddit.length ? reddit : ["None"],
    external_market_check: external.length ? external : ["None"],
    product_concept: `Build a narrow web app focused on '${opp.cluster_key}' that turns recurring signals into a repeatable workflow.`,
    mvp_scope: [
      "Capture the narrowest workflow around the detected pain point.",
      "Provide one opinionated dashboard or automation path.",
      "Instrument activation and retention from day one.",
    ],
    implementation_plan: [
      "Define one primary user persona and one dominant job-to-be-done.",
      "Build the narrowest functional slice that proves repeated usage.",
      "Ship analytics, feedback capture, and a pricing experiment early.",
    ],
    distribution_plan: [
      "Publish the thesis in the communities where the signal originated.",
      "Use the relevant Telegram, Reddit, or email-derived channel as the first distribution wedge.",
      "Track response quality and inbound follow-up questions as validation.",
    ],
    risks: [
      "Signals may reflect noise rather than durable demand.",
      "The market may already have stronger incumbents.",
      "Inbox and channel evidence may over-index on your current network.",
    ],
    decision_for_human_review: "Approve only if the idea is specific enough to build in one narrow iteration.",
  };
}

// --- Main ---

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: tsx research-opportunity.ts <slug-or-topic>");
    process.exit(1);
  }

  const db = getDb();
  initSchema(db);

  // Find or create opportunity
  let opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(target) as any;
  if (!opp) {
    const slug = slugify(target);
    opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(slug) as any;
    if (!opp) {
      // Create ad-hoc opportunity
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
        VALUES (?, ?, ?, 1.0, 'active', ?, '{"ad_hoc": true}', ?, ?)
      `).run(slug, target.trim(), `Investigate whether '${target}' could become a focused web product.`, slug, now, now);
      opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(slug) as any;
      console.log(`Created ad-hoc opportunity: ${slug}`);
    }
  }

  console.log(`Researching: ${opp.title} (${opp.slug})`);

  // Create run
  const now = new Date().toISOString();
  const runResult = db.prepare(`
    INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
    VALUES ('research', 'opportunity', ?, 'running', 'user', ?, '{}')
  `).run(String(opp.id), now);
  const runId = Number(runResult.lastInsertRowid);
  console.log(`Created run #${runId}`);

  // Load linked source items, ranked by harvest score
  const sourceItems = db.prepare(`
    SELECT si.* FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
  `).all(opp.id) as any[];

  console.log(`Found ${sourceItems.length} linked source items.`);

  let searchItems: SearchEvidenceItem[] = [];
  let searchAnswers: string[] = [];
  let searchTrace: {
    provider: string;
    queries: string[];
    answers: string[];
    result_count: number;
    source_item_ids: number[];
  } | null = null;

  if (isSearchConfigured()) {
    try {
      const enrichment = await enrichOpportunityWithSearch(
        { title: opp.title, cluster_key: opp.cluster_key },
        sourceItems,
        runId,
      );
      searchItems = enrichment.items;
      searchAnswers = enrichment.answers;
      searchTrace = {
        provider: enrichment.provider,
        queries: enrichment.queries,
        answers: enrichment.answers,
        result_count: enrichment.items.length,
        source_item_ids: enrichment.item_ids,
      };
      const answerNote = searchAnswers.length ? `, ${searchAnswers.length} synthesized answer(s)` : "";
      console.log(
        `Search enrichment: ${searchItems.length} result(s) across ${enrichment.queries.length} quer${enrichment.queries.length === 1 ? "y" : "ies"}${answerNote}.`,
      );
    } catch (err) {
      console.warn(`Search enrichment failed, continuing without external research: ${err}`);
    }
  } else {
    console.log("No TAVILY_API_KEY — skipping web enrichment.");
  }

  // Build draft
  let draftBody: Omit<ResearchDraft, "opportunity_slug" | "source_refs">;

  if (isLlmConfigured()) {
    try {
      console.log("Building draft via LLM...");
      draftBody = await buildLlmDraft(opp, sourceItems, searchItems, searchAnswers);
    } catch (err) {
      console.warn(`LLM draft failed, using template: ${err}`);
      draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
    }
  } else {
    console.log("No ANTHROPIC_API_KEY — using template draft.");
    draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
  }

  const draft: ResearchDraft = {
    opportunity_slug: opp.slug,
    ...draftBody,
    source_refs: [...new Set([...sourceItems.map((s: any) => s.id), ...searchItems.map((s) => s.id)])],
  };

  // Store draft in run metadata and move to review_gate
  db.prepare("UPDATE runs SET status = 'review_gate', metadata_json = ? WHERE id = ?").run(
    JSON.stringify({
      draft,
      research_trace: {
        source_item_count: sourceItems.length,
        external_search: searchTrace,
      },
    }),
    runId,
  );

  console.log(`\nRun #${runId} moved to review_gate.`);
  console.log("Thesis:", draft.thesis.slice(0, 200));
  console.log(`\nTo approve: tsx approve-run.ts ${runId}`);
  console.log(`To reject:  tsx reject-run.ts ${runId}`);

  closeDb();
}

main().catch((err) => {
  console.error("Research failed:", err);
  process.exit(1);
});
