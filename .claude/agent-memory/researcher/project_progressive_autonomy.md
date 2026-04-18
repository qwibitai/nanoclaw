---
name: Progressive autonomy and outcome-learning memory research
description: Research on adaptive trust systems, outcome-aware agent memory, and verification pipelines — for NanoClaw product differentiation analysis
type: project
---

Research conducted April 2026, training data through Aug 2025. 8-month gap acknowledged.

**Why:** User evaluating whether planned NanoClaw features (progressive autonomy, outcome-learning memory, built-in verification) are novel or already built.

**How to apply:** Frame NanoClaw roadmap against confirmed gaps. Caveat any claims about novelty with the training data gap — recommend research_web for live scan.

## Progressive Autonomy / Graduated Trust

**Finding: No production framework implements approval-pattern-based automatic permission escalation as of Aug 2025. This is a genuine gap.**

- Salesforce Agentforce, Microsoft Copilot Studio, ServiceNow, Google Agentspace: all use admin-configured static permission tiers. No adaptive trust.
- LangGraph: static interrupt nodes (hardcoded, not learned).
- CrewAI, AutoGen: static human_input flags.
- Closest: Copilot Studio "confirm once" (session-scoped only, resets each session).
- AutoGen "teachability": explicit user correction → stored, not passive pattern learning.
- Academic: Reflexion (2023), decision-theoretic HRL — research prototypes only, not shipped.

## Outcome-Aware Memory

**Finding: All major memory layers (Mem0, Letta, Zep, LangMem) focus on semantic recall, not outcome-based behavioral adaptation.**

- Mem0: extracts user facts from conversation. No execution outcome tracking.
- Letta (ex-MemGPT): tiered memory with self-editing. Closest to adaptation but user-statement-driven, not outcome-driven.
- Zep / Graphiti: episodic recall + entity graph. No feedback loop from tool results.
- LangMem: LangChain's module, conversation-extraction-based. No outcome signals.
- Closest academic: Reflexion (verbal failure reflection), Voyager (skill library from successes). Neither shipped as general framework.

## Anti-Hallucination / Verification Pipelines

**Finding: No major agent runtime has built-in verification. Exists as bolt-ons only.**

- Guardrails.ai: format/type validation, not factual verification. Production bolt-on.
- NeMo Guardrails (NVIDIA): fact-checking rail compares vs retrieved documents. Most capable but document-grounded.
- LlamaIndex faithfulness evaluator: RAG-specific, not general.
- No LangGraph/Letta/CrewAI/AutoGen/Claude Agent SDK has native pre-action verification.

## Browser Automation State (mid-2025)

- Browser Use: most popular open-source browser agent (~20k stars). No trust/approval layer.
- Playwright MCP (Microsoft): MCP-wrapped Playwright. Claude's safety training provides soft guardrails only.
- Stagehand (Browserbase): LLM-native abstractions. No approval workflow.
- Skyvern (YC W24): B2B automation, exception escalation to dashboard, not earned trust.
- Common gap: none track approval history to progressively reduce confirmation requirements.

## Novelty Assessment for NanoClaw Features

High novelty (no one has shipped):
- Approval-pattern learning → automatic permission escalation
- Passive execution outcome observation → persistent behavioral memory

Medium novelty (gap confirmed, work underway):
- Pre-action verification pipeline natively in agent loop
- Browser trust tiers based on earned autonomy per site/action type

Lower novelty (existing tools to build on):
- Semantic memory (use Mem0 as base, add outcome layer on top)
- Anti-hallucination middleware (build on Guardrails.ai or NeMo)
