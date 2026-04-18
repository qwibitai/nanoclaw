---
name: Self-hosted personal AI agent frameworks research
description: Research on top self-hosted personal AI agent frameworks 2025-2026 for competitive analysis vs NanoClaw
type: project
---

User is researching competitive landscape for self-hosted personal AI agent frameworks to understand where NanoClaw fits. Full competitive breakdown completed April 2026 (training data Aug 2025; no live web tools available in that session).

**Why:** Informing NanoClaw's product positioning decision — needs to validate uniqueness of container isolation + multi-channel + Claude Agent SDK combination.

**How to apply:** Frame findings in terms of how NanoClaw differentiates (container isolation, multi-channel, Claude Agent SDK integration). Always flag that post-Aug 2025 states require live web search to confirm.

## Framework Status (as of Aug 2025, states after that are UNKNOWN)

- **ElizaOS** — multi-agent Node.js runtime, Discord/Telegram/Twitter built-in, no container isolation, no WhatsApp/Signal. Highest risk of closing the gap — was on v2 path.
- **Khoj** — self-hosted personal AI, RAG + Telegram, query-response only (not ambient), no isolation.
- **OpenHands** — Docker-sandboxed coding agent, no messaging channels, coding-only.
- **AnythingLLM** — self-hosted RAG+LLM, web UI only, no channel connectors, no isolation.
- **LobeChat** — chat UI wrapper, no channel integrations, no ambient operation.
- **AutoGPT** — Docker isolation per task, no messaging channels, task-runner not ambient.
- **n8n** — strongest partial competitor: multi-channel triggers (WhatsApp, Telegram, Slack, Discord, email) + AI agent nodes, BUT stateless workflows, no memory/identity, no isolation.
- **Flowise / Superagent / AgentGPT** — various DIY agent builders, no isolation + limited channel support.

## Browser/Computer Agents (different category — capability tools, not platforms)

- **Manus AI** — cloud product, browser + computer use, viral early 2025. Not self-hosted.
- **OpenManus** — open-source clone, Python, browser-use based. No messaging channels, not ambient.
- **Browser-Use** — Python library for LLM browser control. A tool NanoClaw could consume, not a competitor.
- **Skyvern** — computer-vision browser automation, self-hostable, structured web tasks only.

## Commercial Competitors

- **Lindy.ai** — closest commercial analog (email, Slack, WhatsApp, autonomous), cloud-only, Series A funded. If they ship on-prem, becomes direct threat.
- **Botpress v3** — multi-channel (20+ platforms), self-hostable, but chatbot flows not autonomous agents.
- **Rasa** — enterprise multi-channel ML, CALM LLM mode, steep config, support-team focus.
- **Chatwoot** — multi-channel inbox (support ops), not personal AI.

## Progressive Autonomy

No open-source framework implements trust tiers that persist across sessions and expand based on demonstrated reliability. This is a genuine NanoClaw differentiator if implemented.

## Claude Agent SDK

No known open-source project combines Claude Agent SDK + multi-channel + container isolation as of Aug 2025. NanoClaw appears to be a first-mover here.

## Key Open Questions Requiring Live Search

1. ElizaOS v2 — what channels/features shipped?
2. Any new projects in late 2025/early 2026 targeting "personal AI in messaging apps"?
3. Signal support in other frameworks?
4. Lindy.ai on-prem offering?
5. AutoGPT Platform + messaging channels?
