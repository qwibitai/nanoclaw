# Memory Integration — Operator Manual

The memory system gives NanoClaw agent groups a persistent fact store and synthesised wiki knowledge base.

---

## Architecture

Three-layer pipeline:

```
Raw sources (inbox/, articles/, docs/, transcripts/, clips/, media/)
    ↓ extraction (source-ingestor worker)
mnemon graph (~/.mnemon/data/<agentGroupId>/)
    ↓ synthesise task (daily 03:00 UTC)
Wiki pages (groups/<g>/wiki/)
```

**Three core ops:**

| Op | When | Effect |
|---|---|---|
| **extract** | On file drop into sources/ or chat-stream classifier match | Facts written to mnemon store |
| **synthesise** | Daily cron (03:00 UTC) via scheduled task | Wiki pages updated from current fact graph |
| **recall** | On agent turn (via MCP tool) | Ranked facts injected into context |

**Host daemon** (`nanoclaw-memory-daemon`, `dist/memory-daemon/index.js`): runs as a systemd service alongside `nanoclaw-v2`. Watches enabled groups' `sources/inbox/` directories via inotify and classifies chat-stream turns. Reads `container.json`'s `memory.enabled` field per group on each 60s sweep.

**MemoryConfig interface** (from `src/container-config.ts`): `{ enabled: boolean }`. Set by `scripts/enable-memory.ts`, cleared by `scripts/disable-memory.ts`. Host reads this at container spawn time to apply mnemon mounts and env vars.

---

## Enable Runbook

Enable memory for a group:

```bash
pnpm exec tsx scripts/enable-memory.ts <group-folder>
# e.g.
pnpm exec tsx scripts/enable-memory.ts illysium
```

What happens:
1. `groups/<g>/container.json` gets `memory.enabled = true` (atomic write via `.tmp` + rename).
2. Seven `groups/<g>/sources/` subdirs created: `inbox/`, `articles/`, `docs/`, `transcripts/`, `clips/`, `media/`, `processed/`. Existing dirs are preserved.
3. `mnemon store create <agentGroupId>` runs — "already exists" errors are silently swallowed.
4. A daily synthesise task is scheduled (cron `0 3 * * *`, seriesId `memory-synth-<agentGroupId>`). Idempotent — re-running updates the existing row instead of inserting a duplicate.

No service restart needed. The daemon picks up newly enabled groups on its next 60s sweep.

**Prerequisites:** run `bash scripts/verify-memory-prereqs.sh` first to confirm Ollama is active, nomic-embed-text is pulled, mnemon binary is present, disk space is sufficient, inotify watches are configured, and sqlite3 is in PATH.

---

## Disable Runbook

Disable memory for a group:

```bash
pnpm exec tsx scripts/disable-memory.ts <group-folder>
# e.g.
pnpm exec tsx scripts/disable-memory.ts illysium
```

What happens:
1. `memory` block removed from `groups/<g>/container.json` (atomic write).
2. Active synthesise task cancelled from the group's session `inbound.db`.
3. `watermarks` rows for this `agentGroupId` removed from `data/mnemon-ingest.db`.
4. `dead_letters` rows in `data/mnemon-ingest.db` are **preserved** for operator review.
5. `~/.mnemon/data/<agentGroupId>/` is **preserved** for operator audit.

No service restart needed. The daemon stops watching this group on its next 60s sweep.

Idempotent: running twice on an already-disabled group exits cleanly.

---

## Daily / Weekly / Monthly Operator Runbook

**Daily (~30 sec):**

```bash
# Check memory-health.json for any alarm conditions
cat data/memory-health.json | jq '.groups | to_entries[] | select(.value.recallEmptyRate24h > 0.5 or .value.classifierFails24h > 10)'
# Should return empty. Any hits need investigation.

# Scan daemon error log for unexpected failures
tail -20 logs/memory-daemon.error.log
```

**Weekly (~5 min):**

```bash
# Review dead_letters for poisoned items
sqlite3 data/mnemon-ingest.db "SELECT agent_group_id, item_type, failure_count, last_error FROM dead_letters WHERE poisoned_at IS NOT NULL ORDER BY poisoned_at DESC LIMIT 20;"

# Check wiki autopush status
tail -20 logs/wiki-autopush.log  # should show recent pushes with exit 0

# Verify daemon log has no repeated errors
grep -c "ERROR" logs/memory-daemon.log || true
```

**Monthly (~10 min):**

```bash
# Spot-check mnemon store sizes
for store in $(ls ~/.mnemon/data/ 2>/dev/null); do
  echo "$store: $(du -sh ~/.mnemon/data/$store/ 2>/dev/null | awk '{print $1}')"
done

# Verify mnemon binary version matches Dockerfile
mnemon --version
grep 'MNEMON_VERSION' container/Dockerfile

# Review wiki pages in Obsidian or via cat for any enabled group
# Look for: contradictions, stale facts, orphan pages

# Check daemon log for silent failures
grep "ERROR\|WARN" logs/memory-daemon.log | tail -50
```

---

## Troubleshooting

**`recallEmptyRate24h` spikes in `data/memory-health.json`:**

High empty-recall rate usually means the classifier extraction pipeline isn't writing facts to the mnemon store. Check:
1. `data/memory-health.json` — look at `classifierFails24h` for the affected group.
2. `logs/memory-daemon.log` — search for `classifier` errors near the spike time.
3. Verify mnemon store is reachable: `mnemon store list | grep <agentGroupId>`.
4. Check inotify watcher is active for this group: `inotifywait -m groups/<g>/sources/inbox/` (Ctrl-C to exit; if it hangs immediately the watcher path doesn't exist).

**Classifier failures (`classifierFails24h` elevated):**

```bash
# Check data/memory-health.json for per-group classifier stats
cat data/memory-health.json | jq '.groups["<agentGroupId>"]'

# Tail daemon log for classifier error context
grep -A3 "classifier" logs/memory-daemon.error.log | tail -40
```

Common causes: Ollama is down (recall degrades to keyword-only — non-blocking), mnemon store write lock stale, or schema mismatch after mnemon binary upgrade.

**Inotify watcher debugging:**

```bash
# Verify watch limit
cat /proc/sys/fs/inotify/max_user_watches

# Test watcher on a specific group's inbox
inotifywait -m groups/<g>/sources/inbox/
# Drop a file in another terminal: touch groups/<g>/sources/inbox/test.txt
# Should see: groups/<g>/sources/inbox/ CREATE test.txt

# Increase watch limit if exhausted
echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches
```

**Daemon not starting:**

```bash
# Check systemd status
sudo systemctl status nanoclaw-memory-daemon

# View recent logs
sudo journalctl -u nanoclaw-memory-daemon -n 50

# Verify compiled artefact exists
ls dist/memory-daemon/index.js  # must exist — run pnpm run build if missing
```

**After bumping CLASSIFIER_VERSION / PROMPT_VERSION:**

The chat-stream sweep advances `scan_cursor` past each successfully-classified pair's `sent_at` timestamp. On subsequent sweeps it only reads rows AFTER the cursor — so when `CLASSIFIER_VERSION` or `PROMPT_VERSION` is bumped (e.g., to roll out a smarter grounding prompt), already-classified pairs stay under the OLD version and never get re-extracted. Reset watermarks to force re-classification of historical chat pairs.

**Required runbook (in order):**

```bash
# 1. Stop the daemon FIRST. An in-flight sweep can re-INSERT a watermark
#    row at the in-flight pair's lastSentAt mid-cleanup, silently undoing
#    the replay (ultrareview bug_012).
sudo systemctl stop nanoclaw-memory-daemon

# 2. Dry-run (default): preview which groups would be reset
pnpm exec tsx scripts/reset-classifier-watermarks.ts

# 3. Apply: actually delete watermarks for all groups (triggers re-classify)
pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply

# 4. Restart the daemon so the next sweep picks up cleared watermarks
sudo systemctl start nanoclaw-memory-daemon
```

Single-group variants:

```bash
pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId>          # dry-run
pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId> --apply  # execute
```

**`--include-poisoned`** (ultrareview bug_013): without this flag, `dead_letters` rows are preserved. By design, `classifier.ts` short-circuits any pair with `poisoned_at IS NOT NULL` — so a pair that got poisoned under the OLD prompt (e.g., 3 strikes from `validateFactsAgainstSource` dropping all confabulated facts) will NOT retry under the new prompt, defeating the watermark reset for that pair. When the goal is "reclassify EVERYTHING under the new prompt", add `--include-poisoned` to also clear poisoned rows:

```bash
pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply --include-poisoned
```

The script preserves `processed_pairs` (the PK includes both versions, so v1 and v2 rows coexist). The next 60s sweep after restart replays the archive end-to-end for affected groups. Expect a one-time spike in Anthropic/Codex API calls proportional to historical chat volume — plan cost before running on busy groups. Old-version facts in `~/.mnemon/data/<agentGroupId>/` are NOT deleted; if the old prompt produced confabulations (e.g. "WG → William Grant" before the grounding-discipline bump), use `mnemon forget <fact-id>` to remove specific facts after the new sweep adds correct versions.

---

## Rollback

**Per-group:** disable memory for a specific group without affecting others:

```bash
pnpm exec tsx scripts/disable-memory.ts <group-folder>
```

Data at `~/.mnemon/data/<agentGroupId>/` is preserved. Re-enabling later resumes from the same fact graph.

**Full-system removal:** stop and disable the daemon entirely:

```bash
sudo systemctl disable --now nanoclaw-memory-daemon
```

Then disable per-group if needed:

```bash
for g in groups/*/; do
  folder=$(basename "$g")
  pnpm exec tsx scripts/disable-memory.ts "$folder" 2>/dev/null || true
done
```

Manual cleanup of mnemon stores (irreversible — do only if you want to wipe all stored facts):

```bash
rm -rf ~/.mnemon/data/
```

Relevant paths:
- `scripts/enable-memory.ts` — enable per group
- `scripts/disable-memory.ts` — disable per group
- `scripts/verify-memory-prereqs.sh` — check prereqs before enabling
- `scripts/reset-classifier-watermarks.ts` — re-classify historical pairs after a CLASSIFIER_VERSION/PROMPT_VERSION bump
- `data/memory-health.json` — per-group health snapshot
- `data/mnemon-ingest.db` — watermarks + dead_letters
- `logs/memory-daemon.log` — daemon stdout
- `logs/memory-daemon.error.log` — daemon stderr
- `data/systemd/nanoclaw-memory-daemon.service` — systemd unit (copy to `/etc/systemd/system/` to install)
- `data/systemd/templates/ollama-keep-alive.conf` — drop-in pinning Ollama embed model (operator-installed; see Operator Configuration below)
- `data/systemd/templates/memory-daemon-backend.conf.example` — drop-in for switching classifier backend (operator-customized; see Operator Configuration below)

## Operator Configuration

Two systemd drop-ins live as templates in `data/systemd/templates/`. They're operator-installed because they hold per-host operational choices, not feature defaults.

### Pin the Ollama embed model (recommended)

Without this, Ollama unloads `nomic-embed-text` after 5 minutes of idle and the next mnemon recall catches a 3-5s cold load that times out the recall path. Pinning is essentially free (~565MB RAM):

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo cp data/systemd/templates/ollama-keep-alive.conf \
  /etc/systemd/system/ollama.service.d/keep-alive.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama

# Optional one-time warmup
curl -s http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"warmup"}' >/dev/null

# Verify (expires_at year 2318 = "never" sentinel)
curl -s http://127.0.0.1:11434/api/ps | python3 -m json.tool
```

### Switch the classifier backend (optional)

Default (no drop-in) is Anthropic Haiku 4.5. To switch to a smarter Anthropic model, an entirely different provider, or a different effort level:

```bash
sudo mkdir -p /etc/systemd/system/nanoclaw-memory-daemon.service.d
sudo cp data/systemd/templates/memory-daemon-backend.conf.example \
  /etc/systemd/system/nanoclaw-memory-daemon.service.d/backend.conf

# Edit /etc/.../backend.conf to your chosen backend, e.g.:
#   anthropic:sonnet-4-6:high   (paid per-token, extended thinking)
#   codex:gpt-5.5:medium        (codex subscription, uncorrelated failure mode vs. claude synth)
#   anthropic:haiku-4-5:default (the default)

sudo systemctl daemon-reload
sudo systemctl restart nanoclaw-memory-daemon

# Verify env loaded
systemctl show nanoclaw-memory-daemon -p Environment --no-pager
```

The format is `<provider>:<model>:<effort>`:
- `provider`: `anthropic` | `codex`
- `model`: short alias mapped per-backend (`haiku-4-5`, `sonnet-4-6`, `opus-4-7` for Anthropic; `gpt-5.5`, `gpt-5-codex`, etc. for Codex)
- `effort`: `default` | `low` | `medium` | `high`

If using `codex` and the binary isn't on the daemon's narrow PATH (`/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin`), set `CODEX_BIN=/absolute/path/to/codex` in the same drop-in. The example file shows both env vars.

To revert to default:

```bash
sudo rm /etc/systemd/system/nanoclaw-memory-daemon.service.d/backend.conf
sudo systemctl daemon-reload && sudo systemctl restart nanoclaw-memory-daemon
```

---

## Recall Feedback Loop (Instrumented Memory Recall)

The instrumented recall feature records each fact injected into agent context (`recall_outcomes` table in `data/mnemon-ingest.db`) and asynchronously judges whether the agent's response used the fact. This data drives the `recall_quality` block in `data/memory-health.json`.

### What `recall_outcomes` records

Every recalled fact gets one row with:

| Column | What it means |
|---|---|
| `recall_event_id` | Groups all facts recalled in the same turn (`recall-<message-id>`) |
| `fact_id` | The mnemon fact ID |
| `agent_group_id` | Which group's context was injected |
| `query_strategy` | Which strategy actually ran: `raw`, `heuristic`, or `llm` (records the actual fallback tier, not what was configured) |
| `embedding_sim` | Cosine similarity between the recall query and the fact's embedding (0–1; NULL if Ollama was unavailable) |
| `judge_score` | 0, 1, or 2 — set by the daemon judge after a 60s grace period |
| `judge_method` | `pending` → `llm` / `judge-failed` / `ambiguous-correlation` |
| `judged_at` | When the judge ran; NULL = still pending |

Query directly:

```bash
# Pending rows (not yet judged)
sqlite3 data/mnemon-ingest.db \
  "SELECT recall_event_id, fact_id, query_strategy, embedding_sim, created_at
   FROM recall_outcomes WHERE judged_at IS NULL ORDER BY created_at DESC LIMIT 20;"

# Judged rows with scores
sqlite3 data/mnemon-ingest.db \
  "SELECT fact_id, judge_score, judge_method, query_strategy, embedding_sim, judged_at
   FROM recall_outcomes WHERE judged_at IS NOT NULL ORDER BY judged_at DESC LIMIT 20;"

# Score distribution by strategy (last 7 days)
sqlite3 data/mnemon-ingest.db \
  "SELECT query_strategy, judge_score, COUNT(*) as cnt
   FROM recall_outcomes
   WHERE judged_at > datetime('now', '-7 days')
   GROUP BY query_strategy, judge_score
   ORDER BY query_strategy, judge_score;"
```

### How to read `recall_quality` in `memory-health.json`

```bash
cat data/memory-health.json | jq '.groups | to_entries[] | {group: .key, quality: .value.recall_quality}'
```

Key fields:

| Field | Meaning |
|---|---|
| `coverage_24h` | Fraction of recall events judged within the last 24h (0–1). Low value = daemon backlog or judge failures. |
| `useful_fact_rate_7d` | Fraction of injected facts scoring ≥1 in the last 7 days. Low = facts are topically mismatched. |
| `load_bearing_event_rate_7d` | Fraction of turns where ≥1 fact scored 2 (load-bearing). This is the headline quality signal. |
| `rank_distribution_7d` | Score 0/1/2 breakdown across all judged facts. |
| `judge_failure_rate_24h` | Fraction of events marked `judge-failed`. Should be near zero. |
| `ambiguous_correlation_rate_24h` | Fraction marked `ambiguous-correlation` (multiple recall events in same thread/60s window). |
| `judged_count_total` | Lifetime total judged rows. |
| `judge_retry_p50_24h` | Median retry count from `dead_letters` for judge events. >1 means the daemon is struggling to find agent responses. |

Also check `ollamaCheckHost` at the top level — written by the host at startup:

```bash
cat data/memory-health.json | jq '.ollamaCheckHost'
# { "ok": true, "checkedAt": "...", "endpoint": "http://127.0.0.1:11434" }
```

`ok: false` means Ollama was unreachable at host startup. Embedding similarity (`embedding_sim`) will be NULL for all subsequent recalls until Ollama is restored. Recall still works — the fail-open path continues without embeddings.

To read the host Ollama status file directly:

```bash
cat data/.host-ollama-status.json
```

### feedback_enabled — opt out of observation per group

By default, `feedback_enabled` is true whenever `memory.enabled` is true (default-true per D37 — deliberately the opposite of the cycle-2 design which required explicit opt-in). To disable observation for a specific group without disabling memory:

```bash
# Edit groups/<group-folder>/container.json:
# "memory": { "enabled": true, "feedback_enabled": false }
```

When `feedback_enabled=false`, no `recall_outcomes` rows are written for that group and the daemon judge skips it entirely. No recall_quality data accumulates. Use this if observation overhead is a concern or if the group handles sensitive content that should not be stored in the feedback corpus.

---

## Eval Workflow (Strategy Comparison)

The eval harness measures `recall@5`, `recall@10`, and MRR across all three query strategies (raw / heuristic / llm) against a synthesized test set. Run it before flipping a group's `query_strategy` to `llm`.

### When to run the eval

Run when:
- You're considering flipping a group's `query_strategy` from `raw` to `llm`
- After a significant change to the mnemon store's fact corpus
- As part of a quarterly quality review

### Step 1: Generate the eval set

```bash
pnpm exec tsx scripts/regenerate-recall-eval.ts [--limit 50] [--dry-run]
```

This calls the synthesizer backend (`MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND`, default `codex:gpt-5.5:medium`) to generate a plausible user message for each sampled fact. Operator **must review** `data/recall-eval-set.json` before running Step 2.

Why cross-provider synthesis? The synthesizer deliberately uses Codex (GPT-5.5) rather than Anthropic (the judge's provider). This prevents the synthesized queries from being stylistically pre-tuned to what the judge scores highly — the two providers have uncorrelated biases. Do NOT "fix" this by aligning them to the same provider (C16 hard constraint).

```bash
# Preview without writing
pnpm exec tsx scripts/regenerate-recall-eval.ts --dry-run

# Generate with a smaller set for testing
pnpm exec tsx scripts/regenerate-recall-eval.ts --limit 20
```

### Step 2: Review the eval set

Open `data/recall-eval-set.json`. For each entry, verify:
- `expected_query` is a realistic message a user would send
- `expected_fact_content` is the actual fact (not paraphrased beyond recognition)
- Entries labeled `source: "manual"` are baseline cases — adjust them to fit your actual use case

### Step 3: Run the eval

```bash
# Run all three strategies (default)
pnpm exec tsx scripts/run-recall-eval.ts --strategy all

# Or run a single strategy
pnpm exec tsx scripts/run-recall-eval.ts --strategy llm
```

Output example:
```
Strategy   | Recall@5 | Recall@10 | MRR    | N
-----------|----------|-----------|--------|----
raw        |   42.0%  |    58.0%  | 0.3200 | 50
heuristic  |   48.0%  |    64.0%  | 0.3600 | 50
llm        |   56.0%  |    74.0%  | 0.4100 | 50

[Gate] LLM vs Raw lift on Recall@10: +16.0pp
[Gate] PASS — Strategy C wins by ≥10pp. Safe to flip query_strategy to llm.
```

Results are saved to `data/recall-eval-results.json` (gitignored).

### Step 4: Flip query_strategy (only if gate passes)

The gate threshold is **≥10pp lift on Recall@10** for Strategy C (llm) over Strategy A (raw). If the gate passes:

```bash
# Edit groups/<group-folder>/container.json:
# "memory": { "enabled": true, "query_strategy": "llm" }
```

No restart needed — `recall-injection.ts` caches the config with a 60s TTL, so the new strategy takes effect within 60 seconds.

To revert:

```bash
# Set query_strategy back to "raw" in container.json
# (or remove the field — it defaults to "raw")
```

The fallback chain guarantees recall never breaks: `llm (800ms timeout) → heuristic → raw`. Even if the LLM extractor is unavailable, recall falls through gracefully. The `query_strategy` column in `recall_outcomes` records what **actually** ran (the fallback tier), not what was configured — so your analytics remain honest.

---

## Cross-Group Recall Scope

By default each agent group recalls only from its own mnemon store (`recall_scope: 'self'`). This preserves per-group isolation.

### Flipping to all-groups

The `all-groups` scope is designed for multi-project use cases (e.g. axis-labs, where agents across projects share common institutional facts). **This is a manual operator decision** — there is no automatic revert.

```bash
# Edit groups/<group-folder>/container.json:
# "memory": { "enabled": true, "recall_scope": "all-groups" }
```

After flipping, the next recall will fan out to all memory-enabled groups with 4-way concurrency and 1500ms per-store timeout, then RRF-merge the results. Cross-store failures are tolerated — a store that times out returns empty facts without breaking the recall.

To target specific groups instead of all:

```bash
# "recall_scope": ["axie-dev", "madison-reed"]
# (folder names, not agent group IDs)
```

### Reverting

```bash
# Set recall_scope back to "self" in container.json (or remove the field)
```

### RRF recency boost

The RRF merge applies a recency multiplier: `1 + BOOST * max(0, 1 - age_days/90)`. Default boost is 0.1 (10% advantage for freshly-created facts over 90-day-old facts). To disable:

```bash
# In the daemon drop-in (or systemd unit):
# Environment="MEMORY_RECALL_RRF_RECENCY_BOOST=0"
```

Set `MEMORY_RECALL_RRF_RECENCY_BOOST` in the daemon's environment (not the host's — RRF runs in the host recall path, so set it in the host's `.env` or systemd unit for `nanoclaw-v2`). Values outside `[0, 1]` are clamped with a warning. Completely non-numeric values throw at module load.

---

## Env Vars Reference (Recall Feedback)

| Env var | Process | Default | Purpose |
|---|---|---|---|
| `MEMORY_RECALL_JUDGE_BACKEND` | daemon | `anthropic:haiku-4-5:default` | LLM judge for scoring recalled facts |
| `MEMORY_RECALL_QUERY_EXTRACTOR_BACKEND` | host | `anthropic:haiku-4-5:default` | LLM for Strategy C query extraction |
| `MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND` | scripts | `codex:gpt-5.5:medium` | LLM for generating eval queries (cross-provider per C16) |
| `HOST_OLLAMA_ENDPOINT` | host | `http://127.0.0.1:11434` | Ollama endpoint for embedding cosines |
| `MEMORY_RECALL_RRF_RECENCY_BOOST` | host | `0.1` | Recency multiplier for RRF rerank (0 disables) |
| `CODEX_BIN` | daemon/scripts | `codex` | Path to Codex CLI binary |

All backend vars use the format `<provider>:<model>:<effort>` (e.g. `anthropic:haiku-4-5:default`, `codex:gpt-5.5:medium`).

### HOST_OLLAMA_ENDPOINT

The host reads `HOST_OLLAMA_ENDPOINT` once at module load to compute embedding cosine similarities. Default is `http://127.0.0.1:11434` (the local Ollama port). If you run Ollama on a non-standard port:

```bash
# In .env or the host's systemd unit:
HOST_OLLAMA_ENDPOINT=http://127.0.0.1:11435
```

To diagnose the host-side Ollama check:

```bash
cat data/.host-ollama-status.json
# { "ok": true, "checkedAt": "2026-05-07T04:00:00Z", "endpoint": "http://127.0.0.1:11434" }
```

This file is written at host startup. If `ok: false`, the next batch of recalled facts will have `embedding_sim=NULL` in `recall_outcomes`. Recall itself still works.

The daemon merges this file into `memory-health.json` on each sweep:

```bash
cat data/memory-health.json | jq '.ollamaCheckHost'
```

---

## Quarterly Judge Spot-Check

The judge assigns scores 0/1/2 to each recalled fact based on whether the agent's response used it. These scores are only as reliable as the judge prompt. Perform a quarterly spot-check to detect grade inflation or systematic bias.

**Steps:**

1. Pull 20 recently judged rows from `recall_outcomes`:

```bash
sqlite3 data/mnemon-ingest.db \
  "SELECT ro.recall_event_id, ro.fact_id, ro.judge_score, ro.judge_evidence,
          ro.query_strategy, ro.embedding_sim
   FROM recall_outcomes ro
   WHERE ro.judged_at IS NOT NULL
     AND ro.judge_method = 'llm'
   ORDER BY RANDOM()
   LIMIT 20;"
```

2. For each row, manually assess whether `judge_score` matches your own read of whether the agent used the fact. `judge_evidence` gives the judge's stated reason — evaluate whether the evidence is sound.

3. If you see systematic drift (e.g. judge consistently over-scores at 1 when you'd say 0, or misses load-bearing use):
   - Bump `JUDGE_PROMPT_VERSION` in `src/memory-daemon/recall-judge/judge-client.ts`
   - Old rows with the old version coexist (PK includes `judge_prompt_version`) — no data loss
   - Pending rows from this point on will be judged under the new version
   - Future quarterly checks will compare versions independently

**Spearman ρ between embedding_sim and judge_score** (optional):

If you want to verify that embedding similarity correlates with actual judge usefulness, compute it from the raw rows:

```bash
# Export rows with both fields populated
sqlite3 data/mnemon-ingest.db \
  "SELECT embedding_sim, judge_score
   FROM recall_outcomes
   WHERE embedding_sim IS NOT NULL
     AND judged_at IS NOT NULL
     AND judge_method = 'llm';" > /tmp/sim-scores.csv

# Then compute Spearman ρ in Python or R
python3 -c "
import csv, scipy.stats
rows = list(csv.reader(open('/tmp/sim-scores.csv')))
sim = [float(r[0]) for r in rows if r]
score = [int(r[1]) for r in rows if r]
rho, p = scipy.stats.spearmanr(sim, score)
print(f'Spearman rho={rho:.3f} p={p:.4f} n={len(sim)}')
"
```

No automated script for this — it's operator-driven, quarterly. A ρ near 0 means embedding similarity is not predictive of judge usefulness; a ρ > 0.3 suggests they're correlated and embedding_sim is a cheap early signal worth monitoring.
