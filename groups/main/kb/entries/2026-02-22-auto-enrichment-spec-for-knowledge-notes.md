---
type: tip
title: "Auto Enrichment Spec for Knowledge Notes"
tags: [knowledge-management, enrichment, automation, quality]
related: []
created: 2026-02-22
source: knowledge-warehouse
score: 0
last_reviewed: null
---

Purpose: Keep notes useful over time by adding lightweight context without changing core content.

Triggered on: new notes/links added, manual request ("enrich notes"), scheduled review (e.g., weekly).

What it does:
- Fetches link titles, authors, and publish dates where available
- Adds 2–4 sentence summaries per link or project
- Tags each item with 3–6 topical tags
- Groups related items and deduplicates repeated links
- Preserves original text; enrichment is additive and clearly marked

Output rules:
- ASCII only
- Neutral and factual summaries
- High information quality; push back if provided info is low quality
- If a source cannot be accessed, leave the link and add a short note

Quality criteria for articles:
- Must convey some new idea
- Must share concrete examples of use
- The writing must be excellent
