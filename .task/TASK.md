# TASK: jibot-code-91f — Silent-mode → jibrain intake pipeline broken

**Source**: handed off from Joi's Amplifier session on macazbd (2026-05-09). Beads issue lives at `~/repos/jibot-code` on macazbd as `jibot-code-91f` (P1 bug, owner: Joi). Do NOT close it — return findings + fix; Joi closes from macazbd.

## Headline

**No WhatsApp group has produced a jibrain intake file since 2026-04-26.** Last intake on macazbd: `/Users/joi/switchboard/jibrain/intake/2026-04-24-wa-following-up-on-your-cool-art-direction-post-i-used-t.md` (mtime Apr 26 05:53). ~13 days of silent-mode capture is being dropped.

## CRITICAL: Reframe — this is NOT a v2 regression

The original beads issue framed this as "coinciding with the v2 YAML-first rollout." Joi corrected: **the 4-26 cutoff predates v2.** The upstream nanoclaw repo's v2 cutover commits (migrate-v2.sh, etc.) are late April / early May — after the break. Do not anchor on v2.

Also relevant: in `/Users/joi/repos/nanoclaw` (upstream), `grep -r jibrain` only hits `_legacy/v1.2.49/`. **The jibrain-intake writer is not in the upstream nanoclaw codebase.** It is an external sidecar on this host (jibotmac) — a launchctl agent, a shell script, a hook, or a recipe runner.

The strongest lead: jibot-code commit `19cfb44 chore(scripts): remove stale nanoclaw-jibrain-hook.sh copy (joi-amw)` — there is/was a `nanoclaw-jibrain-hook.sh`. Find where the real one lives (or where it used to live).

## Smoking gun (verify first)

`~/nanoclaw/store/messages.db` was reported 0 bytes, all schema queries fail (no `messages` table, no `registered_groups` table). May 8 12:40 mtime. Verify this is still true; the 0-byte state may itself be a symptom not the cause.

## What works (so the gap is downstream)

- NanoClaw is running (`launchctl list | grep nanoclaw`)
- WhatsApp messages arriving — `/tmp/nanoclaw.stdout.log` has steady `Channel metadata discovered` for the AGI JIDs
- Active/attentive groups still route correctly (`Message routed` log lines for vibez, personal-agents, etc.)
- Baileys auth fully populated (`~/nanoclaw/store/auth/`, ~1,215 entries)
- YAML configs correct (`~/switchboard/ops/jibot/channels/whatsapp-*-agi.yaml`, `intake: true`, `floor: guest`, `listening_mode: silent`)

## Affected groups (all `intake: true`, `listening_mode: silent`)

WhatsApp: agi-main, applied-business-agi, futures-scenarios-agi, marketing-content-agi, presentation-agi, security-agi, ai-oss, vibez. None have produced intake since ~2026-04-26.

## Phase 1: Root cause investigation (DO THIS FIRST — no fixes yet)

Use systematic-debugging methodology. Gather evidence at each layer; do not propose fixes until you can name the root cause with citations.

### Step A — Find the silent-mode → jibrain writer

This is the central unknown. Candidates to check, in order:

1. **launchctl** for any agent referencing jibrain, intake, hook, or the affected groups:
   ```bash
   launchctl list | grep -iE "jibrain|intake|hook|sweep|harvest|nanoclaw"
   ls -la ~/Library/LaunchAgents/ | grep -iE "jibrain|intake|hook|nanoclaw"
   for plist in ~/Library/LaunchAgents/com.jibot.*.plist ~/Library/LaunchAgents/com.nanoclaw.*.plist; do
     echo "=== $plist ==="
     plutil -p "$plist" 2>/dev/null
   done
   ```
2. **Any shell script** named like the removed copy:
   ```bash
   find ~ -name "*jibrain*hook*" -o -name "nanoclaw-jibrain*" -o -name "*-intake-*.sh" 2>/dev/null | grep -v "/.Trash/"
   ```
3. **NanoClaw's own hooks/sidecars** — anything spawned by the nanoclaw process or referenced from `~/nanoclaw`:
   ```bash
   grep -rln "jibrain\|switchboard/jibrain\|wa-.*\\.md" ~/nanoclaw/ 2>/dev/null | head -30
   ```
4. **Per-group memory + IPC**: the writer might be an Agent SDK skill or per-group recipe. Look at the silent-mode groups specifically:
   ```bash
   for slug in agi-main applied-business-agi futures-scenarios-agi marketing-content-agi presentation-agi security-agi ai-oss vibez; do
     echo "=== $slug ==="
     ls -la ~/nanoclaw/groups/$slug/ 2>/dev/null
     echo "--- IPC ---"
     ls -la ~/nanoclaw/data/ipc/$slug/ 2>/dev/null | head -10
   done
   ```
5. **Recipes / amplifier hooks** that might run on jibotmac to pull silent-mode messages and emit intake markdown.

### Step B — Confirm the smoking gun is real

```bash
ls -la ~/nanoclaw/store/messages.db
sqlite3 ~/nanoclaw/store/messages.db ".tables"
sqlite3 ~/nanoclaw/store/messages.db ".schema" 2>&1 | head -50
# Sibling stores?
find ~/nanoclaw -name "*.db" -o -name "*.sqlite*" 2>/dev/null | xargs -I {} sh -c 'echo "=== {} ==="; ls -la {}; sqlite3 {} ".tables" 2>&1'
```

### Step C — Establish the timeline of the break

The mtime on the 0-byte messages.db is May 8 — well after the 4-26 break. So either:
- messages.db was healthy until May 8, and the break was downstream of it, OR
- messages.db has been broken longer and May 8 was a re-truncation

Check:
```bash
# Last 200 lines of stdout, focused on jibrain / intake / silent / sweep
ssh jibotmac true  # warm
tail -500 /tmp/nanoclaw.stdout.log | grep -iE "jibrain|intake|silent|sweep|migration" | tail -50
tail -200 /tmp/nanoclaw.err
# launchctl error logs for any jibrain-named agent
ls -la /tmp/*jibrain* /tmp/*intake* 2>/dev/null
# Any commits to ~/nanoclaw on this host around 4-25 ± 2 days?
cd ~/nanoclaw && git log --since=2026-04-23 --until=2026-04-30 --oneline
# Brew / system update event around 4-26?
brew log 2>/dev/null | head -20
ls -la /var/log/install.log 2>/dev/null
```

### Step D — Trace the write path end-to-end

Once you find the writer, work outward: what reads from (or fails to read from) what feeds it. The likely chain is:

```
WhatsApp message → Baileys → NanoClaw inbound → [silent-mode storage] → [external watcher/hook] → Syncthing → ~/switchboard/jibrain/intake/ on macazbd
```

The break is somewhere in `[silent-mode storage] → [external watcher/hook]`. Find the actual edge.

## Phase 2: Form a single hypothesis

State it explicitly with evidence, then propose minimal test.

## Phase 3: Apply minimal fix and verify

Acceptance criteria from the beads issue:

- [ ] Root cause named with file:line citations and log evidence
- [ ] Schema/storage backend correctly initialized OR external writer correctly wired up
- [ ] **A new WhatsApp message in any of the affected groups produces a file at `~/switchboard/jibrain/intake/` within ~30 min of the fix** (Syncthing will then propagate to macazbd)
- [ ] Documentation written to `~/switchboard/ops/reference/nanoclaw-tiers.md` (or new `~/switchboard/ops/reference/nanoclaw-jibrain-intake.md`) describing the silent-mode → intake path in v2

## Constraints

- Use full absolute paths in all output (`/Users/jibot/nanoclaw/...`, not `~/nanoclaw/...` or `nanoclaw/...`)
- Do NOT modify or `bd close` issue jibot-code-91f — Joi closes from macazbd after reviewing your findings
- If 3+ hypotheses fail, STOP and write up what you tried — do not keep guessing
- Recovery question to answer: are the ~13 days of dropped WhatsApp content recoverable from Baileys-level logs / store / `messages.db.bak` / WhatsApp itself? If not, say so explicitly.
- The nanoclaw stack: Node.js, Claude Agent SDK, Baileys (WhatsApp), signal-cli (Signal), better-sqlite3, js-yaml, Docker (via Colima)

## Deliverables (write to `~/nanoclaw/.task/REPORT.md`)

1. **Root cause** (one sentence)
2. **Evidence trail** (commands run, outputs cited, file:line refs)
3. **Affected code paths** (full absolute paths)
4. **Fix applied** (diff + restart commands)
5. **Verification** (the new intake file that proves the fix works)
6. **Documentation update** (path of doc you wrote/updated)
7. **Data recovery answer** (can the 13 days be recovered? how?)

---

Bonus context: see `~/.claude/skills/jibot/` (or wherever Claude Code's skills live on this host) for nanoclaw architecture references. The `jibot` skill is the canonical reference for tiers, paths, and operations.
