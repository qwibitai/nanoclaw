---
name: extract-trade-ideas
description: Extract trade ideas mentioned in Pod's transcript library and produce a daily ideas digest. Use when the daily extraction task fires, or when Ilan asks "what trade ideas came out of today's pods?" or similar.
---

# Extract Trade Ideas From Pod Transcripts

Pod produces transcripts of every YouTube video and podcast episode it ingests for the Tech / Markets / Stream / Iran feeds. Your job here is to read those transcripts and pull out **specific, sourced, trade-actionable ideas that were mentioned by the pod source** — then deliver a clean digest to Ilan.

You are not creating new trade ideas. You are extracting what the source said or clearly framed.

## Where the transcripts live

Pod's transcript library is mounted read-only at:

```
/workspace/extra/pod-library/transcripts/
├── tech/
│   └── <source>/
│       └── <date>-<title-slug>-<id>/
│           ├── transcript.txt    ← plain text, your primary source
│           ├── clean.md          ← paragraph-formatted (use if transcript.txt is unwieldy)
│           ├── segments.json     ← timestamped segments for citations
│           └── metadata.json     ← provenance: source, engine, publishedAt, url
├── markets/
├── stream/
├── iran/
├── context-packs/
│   ├── local-context.all.md       ← compact candidate map; use for triage only
│   └── local-context.<feed>.md
└── last-ingest.json              ← what was ingested most recently
```

Treat this folder as read-only. Don't try to write to it. (Even if you tried, the mount enforces RO.)

Do not extract trade ideas from `/workspace/extra/pod-library/produced/` by default. Produced episodes are Thedius's own scripts; use them only for de-duplication or when Ilan explicitly asks you to analyze Thedius's published output.

## What counts as a trade idea

A trade idea is **specific** — has a directional thesis, a security/asset/sector/macro exposure, and ideally a horizon and a catalyst.

Only include it if the transcript itself supports it. Examples:

- ✅ Source explicitly says "long Brent" or strongly frames higher crude as the actionable exposure, with a quote.
- ✅ Source says "fade dollar-yen above 160" or "cap dollar-yen after intervention", with a quote.
- ✅ Source highlights a named company/sector as unusually attractive or vulnerable around a catalyst, with a quote.
- ❌ "AI stocks could go either way" — no thesis.
- ❌ "Markets feel toppy" — no security, no horizon.
- ❌ "Bitcoin is interesting" — no tradeable thesis, no horizon.
- ❌ Turning "the dollar is breaking down" into "buy DXY puts / long gold" unless the source actually mentions that exposure.

## How to extract

1. **Find what's fresh.** Read `/workspace/extra/pod-library/transcripts/last-ingest.json`. Grab the `runAt` timestamp and the `feeds` list. The `failures` field tells you what's missing — note it. For the scheduled morning run, cover the prior ingestion window: new transcripts since the previous trade-ideas digest, or the last 24 hours if no prior digest exists. Do not rely on the calendar date alone.

2. **Use the local context pack as a map if present.** Check `/workspace/extra/pod-library/transcripts/context-packs/local-context.all.md` and/or `local-context.<feed>.md`. This pack is candidate context only. Use it to find likely transcripts and exact snippet pointers, but never cite the pack and never treat its paraphrases as verified.

3. **Walk the relevant transcripts.** For each feed in scope, look at episode dirs created since the last extraction. Prefer `metadata.json:createdAt` when present; otherwise use the daily date prefix in the episode directory. Morning digest files can be dated with the current day, but the covered source window may be yesterday afternoon through overnight.

4. **Watchlist/context gate (cheap pre-filter).** Read `/workspace/agent/watchlist.json` once. For each candidate episode, read `metadata.json` first and, if available, the compact context pack entry. Check `tickers`, `people`, `companies`, `topics`, and local context entities/topics/snippets for watchlist intersections (case-insensitive substring on either side). If there is no intersection and no obvious trade-actionable market content, **skip the deep transcript read** and put it in a "gated out" list. Episodes whose `metadata.json` has no entities and no context-pack entry are not gated — read them normally. Episodes with `status: "failed"` are skipped.

   At the end of the digest, include a one-line tally: `Scanned: 14, deep-read: 5, gated out: 9, context-pack used: yes/no.` so Ilan can spot if the gate is too aggressive.

5. **Read the transcripts.** `transcript.txt` is the primary source for the watchlist-relevant episodes. Look for explicit calls: "I'm long X", "the trade is", "fade this", "buy the dip on", "we're net short". Also capture clearly stated directional frames on named assets/sectors, but label them as source-mentioned exposures, not your own trades. Be conservative — extract what's said, don't invent instruments or structures.

6. **Capture the citation.** Every idea must include:
   - The source (channel name, episode title, publishedAt)
   - A short verbatim quote from the transcript that anchors the idea
   - A link to the original (from `metadata.json:pageUrl`)

7. **Write the digest.** Save to `/workspace/agent/trade-ideas/<YYYY-MM-DD>.md`. One file per day. Format:

```markdown
# Pod-Mentioned Trade Ideas — 2026-05-06

Coverage window: prior Pod ingestion window through this morning.

Extracted from transcripts only. These are source-mentioned ideas, not Analyst recommendations.

## High-conviction (multiple sources converging)

- **Source-mentioned: crude upside risk around Hormuz disruption** — include only the exposure and details the sources actually mentioned. Sources:
  - Iran Monitor 2026-05-04 (Crooke, Diesen) — "<verbatim transcript quote>"
  - Markets 2026-05-04 (Hardy / Saxo) — "<verbatim transcript quote>"

## Single-source ideas

- **Source-mentioned: MSFT AI capex risk around earnings** — Markets 2026-05-04 (Visser/Bankless): include the transcript quote that supports the frame.
- **Source-mentioned: copper upside from supply bottleneck** — Markets 2026-05-04 (Forward Guidance / Howell): include the transcript quote that supports the frame.

## Anti-consensus / contrarian

- **Source-mentioned: fade the AI bubble narrative** — Stream 2026-05-04: include only if the source directly frames this as an actionable market idea.
```

8. **Register the ideas.** After writing the digest, import it into the Trade Idea OS so Analyst can track follow-ups:

```bash
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/trade-idea-os.mjs import-digest /workspace/agent/trade-ideas/<YYYY-MM-DD>.md
```

If the import finds no structured bullets or errors, keep the digest intact and mention that the ledger update needs manual review. Do not mark anything `active`; imported pod ideas start as `triage`.

9. **Send a Telegram digest.** Reply in this thread with:
   - Top 3 ideas only (high-conviction first)
   - Each one in 2 lines: the trade + 1 line on the source/catalyst
   - Link to the full file: `trade-ideas/<YYYY-MM-DD>.md`
   - If `last-ingest.json` showed transcript failures, mention the affected feeds in a one-line "transcript gaps" note.

10. **If Ilan asks for deeper work.** Keep the daily extraction source-mentioned only. When Ilan asks "analyze this", "would you do this trade?", "how would you express it?", or similar, switch to the `finance-analyst` skill. Pull live market data, add Analyst overlay, risk/reward, invalidation, sizing/portfolio fit, and clearly separate the source's claim from your own analysis. Update the ledger idea with status, notes, invalidation, follow-up date, and outcome as the work progresses.

## Hard rules

- **Never fabricate trades.** If a transcript says nothing trade-actionable, don't manufacture an idea. Report "no actionable trades from this feed today" honestly.
- **Never upgrade a source frame into your own structure.** If the source says oil risk is rising, don't turn it into calls, futures, spreads, or pair trades unless the source mentioned that structure.
- **Use local context only for token savings.** Context packs and `derived/local-enrichment.json` are maps, not sources. They may decide what to open; final digest entries must come from `transcript.txt` or `clean.md`.
- **Always cite.** Every idea needs source + quote + URL. Anchor in the transcript text.
- **Don't pile up sources artificially.** "High-conviction" requires 2+ independent sources from different channels saying the same thing. One channel mentioning a trade twice is still one source.
- **Don't give trading advice.** Frame as ideas mentioned in pod sources. Ilan decides what to act on.
- **No restating positions you previously extracted unless they have a fresh source today.** This file is daily new ideas, not a running open-positions log.

## When sources are quiet

If the current extraction window has no newly ingested pod transcripts, or all relevant transcripts failed, send one line: "No new pod content - no trade ideas in the current extraction window." Don't reach outside the window. Don't pad.
