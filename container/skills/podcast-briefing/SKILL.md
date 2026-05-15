---
name: podcast-briefing
description: Produce a daily YouTube watchlist briefing for a feed (Tech / Markets / Stream — same shape, different watchlists). Coordinates the full flow from research to publish. Use when the daily briefing task fires or Ilan asks for "today's briefing" on one of those feeds.
---

# Produce a Daily Briefing-Style Pod

Tech, Markets, and Stream share an editorial spine. This skill is the daily produce-a-briefing routine. Iran has its own long-form documentary register — see `iran.brief.md` for that one. Kids is currently archived.

## The flow (in order)

1. **Read the brief.** `/workspace/agent/podcast/feeds/<key>.brief.md` for feed-specific source rules.
2. **Ingest transcripts.** Use the `podcast-research` skill — runs `ingest-transcripts.mjs --feed <key>`. Wait for it to finish.
3. **Check freshness.** Read `podcast/library/transcripts/feed-status.json` for the feed you are producing. Use `last-ingest.json` only for the current run's failures.
4. **Read the transcripts.** From `podcast/library/transcripts/<key>/**/transcript.txt` or `clean.md`. Don't write coverage based on titles or RSS descriptions.
5. **Write the script** to `podcast/scripts/<key>/<key>-YYYY-MM-DD.txt`. Plain prose, no markdown, no bullet markers, no headings (TTS reads it literally).
6. **Publish.** Use the `podcast-publish` skill. Markets publishes with `--feed markets`; Tech and Stream also publish into `markets-feed.rss`, so use `--feed markets --slug tech-YYYY-MM-DD` or `--feed markets --slug stream-YYYY-MM-DD`. Successful publishes also register the script/transcript in `podcast/library/produced/<series>/<slug>/`.
7. **Reply.** Title + R2 URL + one-line through-line. Include `Ingest issues:` section if `last-ingest.json` shows failures.

Reply hygiene: speak directly to Ilan. Do not send meta-status like "Asked Ilan..." or "Replied to Ilan..." in Telegram. If Ilan gave a clear publishing/routing instruction, confirm it as done instead of asking whether it should become the default.

## Editorial spine — the script style

- **One-sentence intro.** Frames the day's through-line. No "today on the show", no "in this episode we'll be looking at", no welcome/preamble.
- **One-sentence outro.** Points to what to watch tomorrow, or ends clean. No "thanks for listening", no calls to subscribe, no boilerplate.
- **Lead with the idea, data, or argument.** Not "in this video, X covers…". Not "Y discussed Z". Open on what's true, what changed, or what was claimed.
- **"So What?" after every key story.** One sharp line on what changes if this is right. Never a recap of what was just said.
- **🎬 only when genuinely screenplay-relevant.** Forced 🎬 dilutes it. Use sparingly.
- **No repetition.** Read the script back holistically before sending. Cut anything redundant.
- **No markdown in scripts.** TTS reads it literally — no `##` headings, no `**bold**`, no bullet markers.

## Source discipline

- **Never list channels/podcasts/sources that had nothing today.** Silently drop them. No roll call. No "no new video from X." No "X had nothing." No "all silent" list at the end. Cover only what actually published.
- **If nothing material to publish, say one short fallback line and stop.** "Quiet day — nothing material" beats fluff. Better silent than padded.
- **Independent and specialist over mainstream wire copy.**

## Length

- 8–12 minutes target. Hard cap 15 minutes.
- Sundays often have zero or near-zero qualifying videos — that's normal. Ship a one-line "quiet Sunday" episode. Don't pad. Don't reach back 72h to manufacture content.

## More substance, less meta

The briefing should replace the need to watch the original. Explain the actual argument, the data, the claim, the mechanism — not just "X covered AI agents this week." If a guest made a specific case, make that case. If a chart showed a trend, describe what it showed and why it matters. Ilan should finish the briefing knowing the substance, not just knowing what was out there. Use judgment to weight the bigger ideas more heavily, but always explain, don't just label.

## Cross-channel synthesis is the value-add

When two or three channels converge on a theme from different angles, name the through-line. The synthesis is what these pods do that no individual channel does.

## What to do if you're stuck

If the brief is missing or thin, ask Ilan rather than guess on format. If an error from the publish script is unclear, quote the literal tool output and stop — don't retry blindly. If transcripts failed, surface that to Ilan in the reply (see `podcast-research` skill for the failure-reporting rule).

## Downstream handoff

Analyst and Bytes consume two Pod library surfaces:

- `podcast/library/transcripts/` for source/external transcripts.
- `podcast/library/produced/` for Thedius-created episode scripts after publishing.

Do not send every script to Analyst/Bytes by message. The file contract is the normal handoff; message them only when there is a gap, repair, or special request.
