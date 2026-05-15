---
name: podcast-publish
description: Publish a podcast episode by running the TTS → R2 → RSS pipeline. Use when an episode script is finished and ready to ship. Covers voice/speed defaults, audio chunking, RSS GUID dedup, and HTTP 200 verification.
---

# Publish a Podcast Episode

The publish pipeline is one generic script that handles every feed. Inputs: a feed key + a finished script (or a pre-generated MP3). Output: an MP3 in R2 + an updated RSS feed, both verified at HTTP 200.

## Command

```
node /workspace/agent/podcast/bin/publish-podcast-episode.mjs \
  --feed <key> \
  --title "Episode Title" \
  --summary "One-sentence description for the feed item." \
  --script-file /workspace/agent/podcast/scripts/<key>/<slug>.txt \
  --slug <slug>
```

If TTS has already been generated, swap `--script-file` for `--mp3-file path/to/<slug>.mp3` to skip the TTS step.

Routing rule: Tech and Stream editorial scripts still live under `podcast/scripts/tech/` and `podcast/scripts/stream/`, but they publish into the consolidated Markets RSS feed. Use `--feed markets --slug tech-YYYY-MM-DD` for Tech and `--feed markets --slug stream-YYYY-MM-DD` for Stream. Markets uses `--feed markets --slug markets-YYYY-MM-DD`; Iran uses `--feed iran`.

## What the script does

1. Loads `podcast/feeds/<key>.config.json` (title, voice, R2 prefix, GUID prefix).
2. If `--script-file`: copies it to `podcast/scripts/<key>/<slug>.txt` and calls OpenAI TTS to produce `podcast/output/<key>/<slug>.mp3`. Scripts > 4000 chars auto-chunk at sentence boundaries.
3. Reads `podcast/feeds/<key>-feed.rss`. Errors if the GUID already exists (no duplicate items).
4. Uploads the MP3 to R2 at `<r2Prefix>/<slug>.mp3`.
5. Inserts the new `<item>` into the RSS feed and uploads the updated feed to R2.
6. HEAD-checks both URLs. Prints both checks. Exits non-zero if either is not 200.
7. Registers the produced episode in `podcast/library/produced/<series>/<slug>/` with `metadata.json`, `transcript.txt`, `clean.md`, and rebuilt `produced/index.*` files for Analyst/Bytes/Thedius.

## Audio defaults (per-feed config)

- **Provider:** OpenAI, model `tts-1-hd`.
- **Voice:** `onyx` (default for everything since 2026-03-25).
- **Speed:**
  - Briefing pods (Tech, Markets, Stream): `1.1x`.
  - Iran: `1.05x` (long-form, considered register).
  - Kids: `1.05x` (slower for younger ears).
  - Marex one-offs: `1.15x` (faster for finance audience).
- **Format:** MP3.

Voice + speed live in each feed's `<key>.config.json`. Don't pass them on the command line.

## RSS feed discipline

- **Never duplicate a GUID.** The publish script enforces this — it errors if `<feed.guidPrefix><slug>` already exists in the feed XML. The error is the right behaviour: investigate before retrying.
- **Don't hand-edit a live RSS feed.** If a fix is needed, edit `podcast/feeds/<feed>-feed.rss` locally then re-upload via `scripts/podcast/sync-podcast-feed.ts --feed <key>` from the host. Don't paste manual XML directly into R2.

## Verification

- **Don't claim an episode is published unless both URLs return HTTP 200.** The publish script does this check automatically and exits non-zero on failure. If it failed, the publish failed — say so, quote the literal error from the tool, stop. Don't retry blindly.
- **Don't paste full scripts back into chat.** Reply with the file path (`podcast/scripts/<feed>/<slug>.txt`) or the R2 URL. Offer a 2–3 line summary if needed. (Permanent rule, 4-strike history.)
- **No fabricated sources or facts.** Every claim in a script must trace to something real. If you don't have it, say "no material published today" rather than invent it.
- **Speak directly to Ilan.** Never report "Asked Ilan" / "Replied to Ilan" as a status line inside Telegram. If you need a decision, ask it directly; if he already gave the instruction, execute and confirm.

## Produced library handoff

Pod's published scripts are a downstream data product. Analyst and Bytes read them through the shared read-only Pod library at `/workspace/extra/pod-library/produced/`.

- Future publishes are registered automatically after HTTP verification succeeds.
- Historical or suspected gaps can be repaired with `node podcast/bin/sync-produced-library.mjs`.
- Agent-to-agent messages are for repair requests only; routine transcript handoff is the file contract.

## Pipeline gotcha

In v1, the `speed` parameter wasn't passed to the TTS API for ~3 weeks — silent default to 1.0x. The v2 publish script always reads `speed` from the feed config and passes it. If audio sounds slower than expected, check the config rather than the API.

## One-off episodes

Occasionally you'll be asked for a one-off — kids' film special, Marex Solutions companion audio, deep-dives on a single topic. Two ways to handle:

1. **Use an existing feed** if it's editorially aligned (e.g. an Iran deep-dive belongs on the Iran feed).
2. **Create a temporary `oneoff` feed** if it doesn't fit anywhere, with `r2Prefix: "one-off"` and a slug that names the topic. Don't pollute a regular feed with content that doesn't belong.

Marex one-offs run at speed 1.15x, not 1.1x.
