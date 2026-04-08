---
name: extract-memories-from-transcripts
description: Extract facts, insights, and style preferences from speech transcripts into the global mnemon database. Run when new transcripts are added or to enrich agent memory.
---

# Extract Memories from Transcripts

Reads speech transcripts from `groups/global/transcripts/`, extracts memorable entries (facts, insights, preferences), presents them to the user for approval, then writes approved entries to the global mnemon database.

---

# Goal

Populate the global mnemon store with high-quality, retrievable knowledge derived from the transcripts — so that all agents automatically surface relevant context when topics like Singapore's foreign policy, regional strategy, or tone/style come up.

# Operating principles

- Process one transcript at a time — present proposals, get approval, write, then move to the next.
- Never write to mnemon without explicit user approval.
- Preserve the distinction between facts (verifiable), insights (analytical/thematic), and preferences (style/rhetoric).
- Mark files as processed only after their entries have been written.
- Global mnemon path: `groups/global/.mnemon` — pass `--data-dir /home/snecvb/vbprojects/nanoclaw/groups/global/.mnemon` to all mnemon commands.

---

# Step 0: Setup

Define key paths:
- TRANSCRIPTS_DIR: `groups/global/transcripts/`
- GLOBAL_MNEMON: `groups/global/.mnemon`
- PROCESSED_LOG: `groups/global/transcripts/processed.txt`

Read the processed log if it exists:
```bash
cat groups/global/transcripts/processed.txt 2>/dev/null || echo "(none processed yet)"
```

List transcript files (exclude CLAUDE.md, TRANSCRIPTS_INDEX.md, processed.txt):
```bash
ls groups/global/transcripts/*.md | grep -v 'CLAUDE.md\|TRANSCRIPTS_INDEX.md'
```

Identify which transcripts have NOT been processed (not in processed.txt). Present the list to the user.

Use AskUserQuestion to ask: "Which transcripts would you like to extract memories from?"
- One option per unprocessed transcript (show filename and date)
- Option: "All unprocessed transcripts"
- Option: "Skip — done for now"

If Skip, stop here.

---

# Step 1: Extract proposals from one transcript

For each selected transcript (process one at a time):

Read the full transcript file.

Then, using your own analysis (no external API call needed — you are Claude), extract proposed mnemon entries. For each entry determine:

- **content**: A self-contained statement that will be useful when retrieved out of context. Include the source (e.g. "— SIIA 2025") at the end.
- **category**: one of `fact` | `insight` | `preference` | `context` | `decision`
- **importance**: 1–5 (use 4–5 for things that should reliably surface; 3 for useful but secondary; 1–2 sparingly)
- **tags**: 2–4 short tags for retrieval (e.g. `singapore`, `foreign-policy`, `china`, `style`)

### What to extract

**Facts (cat: fact)** — Specific, verifiable statements. Aim for 6–10 per transcript.
- Statistics and figures (GDP, trade ratios, defence spending, dates)
- Policy positions stated explicitly
- Historical references used as anchors (Rajaratnam, LKY, Pax Americana, specific events)
- Named frameworks or concepts introduced (e.g. "omni-directional engagement", "infinitely repeated games")
- Specific bilateral or multilateral stances

**Insights (cat: insight)** — Analytical or thematic linkages. Aim for 4–8 per transcript.
- The strategic rationale behind a position (the "because")
- How different themes connect (e.g. small-state vulnerability → rules-based order → ASEAN centrality)
- Observations about the world state that inform Singapore's behaviour
- Tensions held simultaneously (realism vs. idealism, sovereignty vs. interdependence)

**Preferences (cat: preference)** — Style, tone, rhetorical patterns. Aim for 3–5 per transcript.
- Signature phrases or formulations (exact quotes when important)
- Structural patterns (e.g. "opens with historical sweep, then current analysis, then forward-looking call to action")
- What analogies or metaphors are used (billiards, mahjong, chess)
- Register and stance (measured, non-polemical, self-deprecating humour, classical references)

### Importance calibration

| Score | When to use |
|-------|-------------|
| 5 | Core, durable principles that define Singapore's foreign policy identity |
| 4 | Important facts/insights that should reliably surface in discussion |
| 3 | Useful supporting context — worth having but not essential |
| 2 | Specific or dated detail — low retrieval priority |
| 1 | Rarely needed — only for completeness |

---

# Step 2: Present proposals

Format each proposal as a numbered block:

```
[1] cat:fact  imp:5  tags:singapore,gdp,trade
    Singapore's trade-to-GDP ratio is ~300% — among the highest in the world, making free
    trade existential, not merely ideological. — SIIA Jan 2025

[2] cat:insight  imp:5  tags:foreign-policy,rules-based-order,small-state
    Singapore's defence of the rules-based international order is not altruistic — it is
    the structural precondition for a small state without hinterland or natural resources
    to have agency and economic survival. — SIIA Jan 2025

[3] cat:preference  imp:4  tags:style,rhetoric,analogy
    Vivian's preferred analogy for diplomacy: mahjong (infinitely repeated games, reciprocity,
    trust-and-verify) rather than chess (turn-based, bilateral) or billiards (chain reactions,
    unintended consequences). — SIIA Jan 2025
```

After displaying all proposals for the transcript, use AskUserQuestion to ask:
"Which entries should be written to global mnemon?"
- Present as a multiSelect list with one option per entry (label: "[N] {first 60 chars of content}")
- Also add option: "All of the above"
- Also add option: "None — skip this transcript"

---

# Step 3: Write approved entries

For each approved entry, run:
```bash
mnemon remember "<content>" --cat <category> --imp <importance> --data-dir /home/snecvb/vbprojects/nanoclaw/groups/global/.mnemon
```

After all entries for the transcript are written, mark it as processed:
```bash
echo "<filename>" >> groups/global/transcripts/processed.txt
```

Tell the user how many entries were written for this transcript, then proceed to the next selected transcript.

---

# Step 4: Repeat for remaining transcripts

Continue with Step 1–3 for each remaining selected transcript.

After all transcripts are done:

Run a status check:
```bash
mnemon status --data-dir /home/snecvb/vbprojects/nanoclaw/groups/global/.mnemon
```

Show the final count and a summary of what was added.

---

# Step 5: Update global CLAUDE.md (optional)

After extraction, ask the user (AskUserQuestion, yes/no):
"Would you like to add a 'Key Themes' section to groups/global/CLAUDE.md summarising the main pillars extracted?"

If yes:
- Read `groups/global/CLAUDE.md`
- Synthesise a concise (8–12 bullet) section covering the core thematic pillars across all processed transcripts
- The section should serve as a standing "always loaded" primer for agents — not a summary of each speech, but the distilled worldview
- Add it under a `## Foreign Policy Foundations` heading (or update if already present)
- Do not duplicate content that's already there

---

# Notes

- The transcripts are Vivian Balakrishnan's speeches as Singapore's Minister for Foreign Affairs.
- Agents will retrieve these memories via `mnemon recall "keyword"` — so content should be written in a way that surfaces on relevant keyword queries, not just verbatim matches.
- Style/preference entries are especially valuable for tone calibration — write them descriptively enough that an agent reading them would understand how to adapt their register.
- If a fact or insight appears in multiple transcripts, write it once (from the most articulate version) rather than duplicating it. Check existing entries with `mnemon search "<keyword>" --data-dir <path>` before adding near-duplicates.
