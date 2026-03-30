/**
 * LLM prompt templates for insight extraction and research drafting.
 * Ported from idea-maze-lab flows/harvest.md and flows/research.md.
 */

export const HARVEST_SYSTEM_PROMPT = `You are an analyst extracting product opportunity signals from raw source content.

## Goal
Find recurring friction, complaints, manual workarounds, and repetitive tasks that can become product opportunities.

## Core Principles
- Chase friction. Start with one pain point, then trace the adjacent pains until they form a workflow.
- Every complaint online is a free focus group.
- Every repetitive task is a business model waiting for an agent.

## Prioritize
- Replies, follow-ups, comment threads, and question chains
- Complaints with concrete context, emotion, urgency, or frequency
- Repeated manual workarounds and process glue
- Signals that mention money, time loss, coordination, or switching between tools
- Sources that expose current spending, outsourcing, or repeated labor

## Deprioritize
- Generic inspiration and broad trend commentary
- Polished announcements without user pain
- Hot takes that do not describe a real workflow
- One-off complaints with no repetition or operational context
- Promotional or self-serving sources unless pain is corroborated

## Decision Rubric
Score higher when:
- multiple people describe the same pain
- the workaround is manual or repetitive
- the pain clearly sits inside a larger workflow
- the pain is recent, specific, and costly in time, money, or attention
- there is evidence that people already pay, outsource, or spend meaningful time on the task`;

export function buildHarvestUserPrompt(item: {
  source: string;
  channel_or_label?: string | null;
  title: string;
  text: string;
  harvest_score: number;
}): string {
  return `Analyze this source item and extract product opportunity insights.

Source: ${item.source}
Channel/Label: ${item.channel_or_label ?? "None"}
Title: ${item.title || "None"}
Harvest Score: ${item.harvest_score}

Content:
${item.text.slice(0, 4000)}

Return JSON with this exact structure:
{
  "insights": [
    {
      "insight_type": "pain_point" | "demand_signal" | "workflow_gap" | "distribution_clue" | "willingness_to_pay" | "competitor_move" | "implementation_constraint",
      "summary": "One clear sentence describing the insight",
      "evidence_score": 0.0 to 1.0,
      "confidence": 0.0 to 1.0,
      "metadata_json": {
        "pain_point": "...",
        "actor": "...",
        "current_workaround": "...",
        "repetitive_task": "...",
        "adjacent_pains": "...",
        "workflow_stage": "...",
        "evidence_strength": "...",
        "why_now": "..."
      }
    }
  ]
}

Return 1-3 insights. Only include high-confidence signals. Return an empty insights array if nothing meaningful can be extracted.`;
}

export function buildBatchHarvestUserPrompt(items: Array<{
  index: number;
  source: string;
  channel_or_label?: string | null;
  title: string;
  text: string;
  harvest_score: number;
}>): string {
  const itemBlocks = items.map((item) => `
--- ITEM ${item.index} ---
Source: ${item.source}
Channel/Label: ${item.channel_or_label ?? "None"}
Title: ${item.title || "None"}
Harvest Score: ${item.harvest_score}
Content:
${item.text.slice(0, 1500)}`).join("\n");

  return `Analyze each source item below and extract product opportunity insights.

${itemBlocks}

Return JSON with this exact structure:
{
  "items": [
    {
      "index": <item index>,
      "insights": [
        {
          "insight_type": "pain_point" | "demand_signal" | "workflow_gap" | "distribution_clue" | "willingness_to_pay" | "competitor_move" | "implementation_constraint",
          "summary": "One clear sentence describing the insight",
          "evidence_score": 0.0,
          "confidence": 0.0,
          "metadata_json": {
            "pain_point": "...",
            "actor": "...",
            "current_workaround": "...",
            "repetitive_task": "...",
            "adjacent_pains": "...",
            "workflow_stage": "...",
            "evidence_strength": "...",
            "why_now": "..."
          }
        }
      ]
    }
  ]
}

Include an entry for every item index. Return empty insights array for items with no meaningful signal. Return 0-3 insights per item.`;
}

export const RESEARCH_SYSTEM_PROMPT = `You are a product researcher turning a shortlisted opportunity into a reviewable research artifact.

## Core Principles
- Verify the pain before expanding the idea.
- Follow connected pains until the solution becomes a workflow.
- Repetition matters more than novelty.
- The best businesses come from owning the chain of friction, not one isolated feature.
- Research should produce a buildable, reviewable artifact, not a vague market essay.

## Opportunity Shapes To Test
- Missing integration glue created by new APIs, changelogs, or tech-stack migrations
- Productized versions of repeated agency, contractor, or Upwork work
- Vertical agents built around one repetitive back-office task
- Spreadsheet, template, or Zap replacements that collapse repeated coordination
- Concierge or directory-style services only when the coordination workflow is repeated and painful

## Deprioritize
- Broad market summaries with no workflow detail
- Feature ideas that do not control a meaningful step in the workflow
- Research that cannot explain why users would switch from current behavior
- Model-capability-first ideas where the user pain is weak or generic`;

export function buildResearchUserPrompt(opp: {
  slug: string;
  title: string;
  thesis: string;
  inbox_evidence: string[];
  telegram_evidence: string[];
  reddit_evidence: string[];
  external_research: string[];
  search_synthesis?: string[];
}): string {
  const fmtList = (items: string[]) => items.length ? items.map((s) => `- ${s}`).join("\n") : "- None";

  const synthSection = opp.search_synthesis?.length
    ? `\n## Web Search Synthesis\n${opp.search_synthesis.map((a, i) => `Query ${i + 1}: ${a}`).join("\n\n")}\n`
    : "";

  return `Research this opportunity and produce a detailed draft.

Opportunity: ${opp.slug}
Title: ${opp.title}
Current Thesis: ${opp.thesis}
${synthSection}
## Evidence from Inbox
${fmtList(opp.inbox_evidence)}

## Evidence from Telegram
${fmtList(opp.telegram_evidence)}

## Evidence from Reddit
${fmtList(opp.reddit_evidence)}

## External Research
${fmtList(opp.external_research)}

Return JSON with this exact structure:
{
  "thesis": "A precise thesis statement",
  "evidence_from_inbox": ["evidence item 1", ...],
  "evidence_from_telegram": ["evidence item 1", ...],
  "evidence_from_reddit": ["evidence item 1", ...],
  "external_market_check": ["finding 1", ...],
  "product_concept": "A clear product concept description",
  "mvp_scope": ["scope item 1", ...],
  "implementation_plan": ["step 1", ...],
  "distribution_plan": ["channel 1", ...],
  "risks": ["risk 1", ...],
  "decision_for_human_review": "A clear statement for the reviewer"
}`;
}
