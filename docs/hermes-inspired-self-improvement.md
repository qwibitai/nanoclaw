# Hermes-Inspired Self-Improvement for NanoClaw

This is an implementation guide for a future NanoClaw coding session. It captures the plan for adopting the best Hermes Agent ideas without turning NanoClaw into Hermes.

Use this document when the user says something like "implement the Hermes self-improvement plan" or "add the Hermes skill loop to NanoClaw."

## Goal

Add a NanoClaw-native learning loop:

1. Agents can create and refine per-group procedural skills.
2. Agents keep durable facts and active tasks separate from procedural skills.
3. A background review pass can update skills and memory after meaningful work.
4. A curator can later consolidate, pin, archive, and clean up agent-created skills.
5. Past conversations become searchable without breaking NanoClaw's DB invariants.

The desired end state is:

- NanoClaw stays a containerized, per-group agent habitat.
- Skills become writable, reviewable, and local to each group.
- Dangerous self-modification remains approval-gated.
- Model/provider choice remains independent from the orchestration layer.

## Non-Goals

Do not do these unless the user explicitly changes direction:

- Do not replace NanoClaw with Hermes.
- Do not port Hermes' full monolith, TUI, gateway, config system, or Skills Hub.
- Do not let ordinary agents silently edit NanoClaw source code as "self-improvement."
- Do not make package installs, MCP server additions, or host-level changes bypass approvals.
- Do not add external memory services such as Honcho as a default dependency.
- Do not implement deletion-first cleanup. Prefer archive, pin, and snapshot.

## Design Principles

- **Visible files over hidden state.** Agent-created skills should live in the group workspace, not only under `data/`.
- **Per-group isolation.** A skill learned by one group should not automatically affect another group.
- **Structured tools over raw writes.** Agents can already write files, but `skill_manage` should validate the shape and safety of persistent procedural memory.
- **Procedures go to skills. Facts go to memory. Tasks go to task files.**
- **Background review must not send user-facing messages.** It should mutate memory/skills and write an internal summary.
- **Keep one-writer DB invariants.** If indexing history, add a separate host-owned DB or importer path rather than writing into session DBs from both sides.
- **Provider-neutral where practical.** Claude Code gets native skills/hooks. Codex and OpenCode need explicit MCP/config support to reach similar behavior.

Use this split everywhere:

| Knowledge type | Home | Example |
| --- | --- | --- |
| Durable user facts/preferences | `STANDING_FACTS.md` or structured memory files | User prefers compact status updates. |
| Open work state | `OPEN_TASKS.md` or task-specific files | Deployment blocked on missing env var. |
| Reusable how-to procedure | Skills | When this deploy failure occurs, check these logs and restart only this service. |
| Old transcript retrieval | Session search | Have we solved this kind of failure before? |

This rule is the main defense against memory files becoming a soup of preferences, stale task state, and half-procedures.

## Current Repo Anchors

Start by rereading these files:

- `container/CLAUDE.md` - base agent instructions and current hot-file memory model.
- `src/claude-md-compose.ts` - regenerates per-group `CLAUDE.md` and imports module fragments.
- `src/container-runner.ts` - mounts `/workspace/agent`, `/app/skills`, and `/home/node/.claude`; resolves provider contributions.
- `container/agent-runner/src/mcp-tools/index.ts` - built-in MCP tool registration barrel.
- `container/agent-runner/src/mcp-tools/self-mod.ts` - approval-backed self-mod request pattern.
- `container/agent-runner/src/poll-loop.ts` - where normal user turns are processed.
- `container/agent-runner/src/providers/claude.ts` - Claude Code SDK integration, hooks, skills, transcript archiving.
- `docs/skills-as-branches.md` - current repo-level skill philosophy.
- `docs/agent-runner-details.md` - provider interface and provider-specific behavior.

Hermes reference points from the previous deep dive:

- `tools/skill_manager_tool.py` - `skill_manage` validation and mutation model.
- `run_agent.py` - background self-improvement review after turns.
- `agent/curator.py` - periodic skill curation.
- `tools/session_search_tool.py` and `hermes_state.py` - FTS5-backed session search.

If `/tmp/hermes-agent-deepdive` no longer exists, reclone `https://github.com/nousresearch/hermes-agent` before comparing implementation details.

## Phase 1: Per-Group Writable Skills

Add a local skill root:

```text
groups/<folder>/skills/<skill-name>/SKILL.md
groups/<folder>/skills/<skill-name>/references/*
groups/<folder>/skills/<skill-name>/templates/*
groups/<folder>/skills/<skill-name>/scripts/*
groups/<folder>/skills/<skill-name>/assets/*
groups/<folder>/skills/.usage.json
groups/<folder>/skills/.archived/*
groups/<folder>/skills/.snapshots/*
```

Recommended first policy:

- Shared skills remain in `container/skills/<name>`.
- Local group skills live in `groups/<folder>/skills/<name>`.
- Local skill names must not collide with shared skill names at first.
- Archived skills move to `groups/<folder>/skills/.archived/<timestamp>-<name>/`.
- Local skills are always enabled for that group unless archived.
- `container.json.skills` continues to control shared skills only.
- MVP should keep lifecycle metadata in `.usage.json`; a later version can add per-skill `metadata.json` if that proves easier to inspect.

Update skill symlink composition:

- Existing shared skill links point from `.claude-shared/skills/<name>` to `/app/skills/<name>`.
- Add local skill links pointing to `/workspace/agent/skills/<name>`.
- Keep symlink targets as container paths, matching the current pattern.
- Do not delete non-symlink entries in `.claude-shared/skills`.
- If a local/shared name collision exists, skip the local skill and log a warning until a deliberate override policy exists.

Likely edit sites:

- `src/container-runner.ts`, `syncSkillSymlinks`.
- Possibly `src/claude-md-compose.ts` if local skills will support `instructions.md` fragments.

Acceptance checks:

- A local skill under `groups/<folder>/skills/foo/SKILL.md` appears in `/home/node/.claude/skills/foo` inside a running container.
- Shared skills still appear as before.
- Removing or archiving a local skill removes only its symlink.
- Existing user-created non-symlink entries are preserved.

## Phase 2: `skill_manage` and `skill_view` MCP Tools

Add provider-neutral MCP tools under:

```text
container/agent-runner/src/mcp-tools/skills.ts
container/agent-runner/src/mcp-tools/skills.instructions.md
```

Register them in:

```text
container/agent-runner/src/mcp-tools/index.ts
```

### `skill_view`

Purpose: read skills and support files in a provider-neutral way.

Why: Claude Code may use its native `Skill` tool, but Codex/OpenCode need an explicit path to inspect skills reliably.

Suggested actions:

- `list`: list shared and local skills with name, source, description, and archived state.
- `read`: read a full `SKILL.md`.
- `read_file`: read an allowed support file from a skill.

Track view usage for local skills in `.usage.json`.

### `skill_manage`

Purpose: create and safely mutate local per-group skills.

Suggested actions:

- `create`
- `propose_create`
- `edit`
- `patch`
- `propose_update`
- `write_file`
- `archive`
- `pin`
- `unpin`
- `record_use`

Skip true delete for MVP.

Implementation guidance:

- Directly write under `/workspace/agent/skills`.
- This does not require host approval because the agent can already write group workspace files.
- The value is validation, provenance, and consistency, not additional authority.
- Still never allow writes outside `/workspace/agent/skills`.
- Foreground updates may write directly after validation.
- Background review should either write directly only when confidence is high and risk is low, or write a pending proposal event first.
- Risky skill content should be rejected or escalated to admin approval rather than silently persisted.

Validation rules:

- Skill name regex: `^[a-z0-9][a-z0-9-]{0,63}$`.
- No names starting with `.`.
- No path traversal.
- Resolve paths and verify they remain under the local skill root.
- `SKILL.md` must start with YAML frontmatter.
- Frontmatter must include `name` and `description`.
- Frontmatter `name` should match the directory name.
- Body must be non-empty.
- `SKILL.md` max size: 100 KB.
- Support file max size: 1 MB.
- Support files only under `references/`, `templates/`, `scripts/`, or `assets/`.
- Atomic writes: write temp file then rename.
- Archive by moving, not deleting.

Risk scanner rules:

- Flag secrets, API keys, tokens, private URLs, credentials, and `.env` contents.
- Flag instructions that bypass NanoClaw approvals.
- Flag instructions to modify NanoClaw platform/source code without admin approval.
- Flag overbroad filesystem, host, Docker socket, or container escape assumptions.
- Flag user preference facts that belong in memory instead of skills.
- Flag active task state that belongs in `OPEN_TASKS.md` or task files.
- Flag inline executable shell blocks that encourage blind copy/run behavior.
- Skills may mention commands, but they should describe checks, decision points, and expected outcomes.

For `patch`, prefer a simple first version:

- Accept `oldText` and `newText`.
- Require exactly one match.
- Reject ambiguous or missing matches.

Unified diff parsing can come later.

`.usage.json` sketch:

```json
{
  "skills": {
    "example-skill": {
      "createdBy": "agent",
      "origin": "foreground",
      "createdAt": "2026-05-11T00:00:00.000Z",
      "updatedAt": "2026-05-11T00:00:00.000Z",
      "sourceTurnIds": [],
      "sourceConversationIds": [],
      "reviewStatus": "unreviewed",
      "viewCount": 0,
      "useCount": 0,
      "patchCount": 0,
      "lastViewedAt": null,
      "lastUsedAt": null,
      "lastPatchedAt": null,
      "state": "active",
      "pinned": false
    }
  }
}
```

Useful tests:

- Reject path traversal in skill names and support file paths.
- Reject missing frontmatter.
- Reject missing description.
- Reject shared-skill name collision.
- Reject or escalate risky content from the risk scanner.
- Create skill atomically.
- Patch exactly one occurrence.
- Archive moves to `.archived` and updates usage state.
- Pin prevents curator archive later.
- `record_use` appends use/provenance data without corrupting `.usage.json`.

Run:

```bash
pnpm run typecheck
pnpm run test:container
```

## Phase 3: Prompt Guidance for Foreground Learning

Add `container/agent-runner/src/mcp-tools/skills.instructions.md`.

Because `src/claude-md-compose.ts` already imports every built-in `*.instructions.md` fragment, this should enter every group's composed `CLAUDE.md` automatically.

Guidance should say, in plain agent-facing terms:

- Use skills for reusable procedures, checklists, workflows, troubleshooting patterns, and domain-specific methods.
- Use memory files for user facts and preferences, not procedures.
- Use `OPEN_TASKS.md` for active plans.
- When a loaded skill is wrong, incomplete, or outdated, patch it before finishing.
- After a complex task or repeated failure, consider creating or updating a skill.
- Prefer updating an existing skill over creating a narrow new micro-skill.
- Do not capture transient environment failures, one-off narratives, secrets, or instructions to bypass approvals.
- Do not use skill updates as a substitute for package/MCP/source-code self-mod approval flows.
- Do not tell the user about background self-improvement unless it is relevant to the user's task.

Keep this short. The agent already has a lot of prompt surface.

Acceptance checks:

- New composed group `CLAUDE.md` imports `module-skills.md`.
- The agent sees `skill_manage`/`skill_view` guidance without editing `CLAUDE.local.md`.
- Existing memory instructions remain clear and non-duplicative.

## Phase 4: Foreground Skill Self-Improvement

Before building background automation, make normal turns able to self-improve.

Manual canary flow:

1. Ask an agent to solve a nontrivial repeated workflow.
2. Ask it to save the reusable procedure.
3. Confirm it uses `skill_manage create` or `skill_manage edit`.
4. Restart the container.
5. Confirm the new skill is discoverable.
6. Ask a related task and confirm the agent reuses the skill.

This phase proves the core file/symlink/tool loop without background complexity.

## Phase 4.5: Inline After-Action Review

Before adding a separate background reviewer, every agent should get a lightweight review checkpoint in its shared skill instructions. This is the practical bridge between the MVP and Hermes-style autonomous review.

After meaningful domain work, the agent should briefly ask itself:

- Did this reveal a reusable procedure, checklist, prompt pattern, rubric, troubleshooting path, or quality bar?
- Did the user correct a process or preference in a way that should shape future work?
- Did an existing skill help, fail, or need a small update?

This should happen naturally after completed deliverables such as podcast outlines, trade ideas, research memos, builds, deployments, debug sessions, and reports.

Reflection should be required, but mutation should be optional. "Nothing to save" is a valid outcome and should be common. If the reusable value is weak, speculative, temporary, or already covered by an existing skill, the correct action is to make no change.

The agent should only save process that compounds. Good examples: "how to evaluate a trade idea", "how to QC a podcast episode", "how to debug this repo's container startup". Bad examples: market calls, episode-specific facts, temporary source findings, or conclusions that expire.

This phase is intentionally instruction-driven. It does not require a hidden second model run, so it is cheap and immediately useful. The later background reviewer can make the same behavior more consistent without relying on the user-facing agent to remember the checkpoint.

## Phase 4.6: Coordinator Agent Pattern

NanoClaw V2 should use the agent substrate instead of recreating a monolithic V1 self-improvement task. The main Thedius agent can coordinate specialist agents through agent-to-agent destinations:

- Specialists send a short daily status packet to Thedius.
- Thedius logs packets internally in `groups/thedius/ops-vault/agent-logs/<agent>.md` and sends one user-facing daily report.
- Thedius keeps durable process knowledge in `groups/thedius/ops-vault/wiki/`, with `index.md` as a navigation map and `log.md` as a chronological maintenance record.
- The report covers progress, blockers, scheduled-job health, and skill/self-improvement activity.
- Thedius proposes at most one setup improvement per day.

This preserves the useful V1 habit of daily operational improvement while avoiding V1's tendency toward automatic churn. The daily proposal should be conservative: propose, ask, or say "no setup change recommended today" when nothing clears the bar.

## Phase 5: Background Self-Review

Hermes runs a background review after meaningful turns. NanoClaw should do the same, but not by injecting a public chat message.

Preferred architecture:

1. The main poll loop finishes a turn and writes the normal response.
2. The runner or host records enough metadata to decide whether review should trigger.
3. A separate internal review run starts for the same group.
4. The review run uses a separate continuation/session from the user-facing conversation.
5. The review run has only safe tools: read/search, `skill_view`, `skill_manage`, and memory-file writes.
6. The review run is instructed not to send user-facing messages.
7. It writes a compact internal summary to a log or group journal.

Do not simply enqueue a normal user-visible message. That risks confusing channels and polluting the conversation.

MVP trigger options:

- Every N user turns, default 10.
- After a turn where tools were used.
- After a turn that hit an error/retry path.
- After a scheduled task completes with meaningful output.

More precise later:

- Count tool calls from provider events or hooks.
- For Claude, the existing PreToolUse/PostToolUse hooks can increment a counter.
- For Codex app-server, count tool/command notifications.

Self-review should ask:

- Did this turn reveal a reusable procedure?
- Did the agent repeat a troubleshooting pattern?
- Did an error require multiple retries?
- Would a future agent benefit from a skill?
- Should this become memory, task state, a skill, or session-search history?

Review prompt shape:

```text
You are the internal NanoClaw self-improvement reviewer for this agent group.

Review the completed conversation excerpt. Do not send any user-facing message.
Only update durable memory or procedural skills when there is clear reusable value.

Use memory for stable facts/preferences.
Use skills for reusable procedures.
Prefer patching an existing local skill over creating a new one.
Do not save secrets, one-off task details, transient environment failures, or instructions that bypass approvals.
If nothing should be saved, do nothing.

At the end, write a short internal summary of actions taken.
```

Internal event shape for proposal mode:

```json
{
  "type": "self_improvement_candidate",
  "visibility": "internal",
  "groupId": "engineering",
  "turnId": "turn_123",
  "recommendation": "propose_skill_update",
  "skillTitle": "Docker Compose Port Conflict Handling",
  "summary": "Resolved a repeated port conflict by checking listeners, remapping compose ports, and restarting only the affected service.",
  "evidence": ["port 3000 was occupied", "restart succeeded after remap"],
  "risk": "low"
}
```

Open design decision:

- Run this inside the existing container runner as an auxiliary provider call, or have the host enqueue a special internal job.

Recommendation:

- Start with a runner-local helper because it already has provider, cwd, MCP, and group filesystem context.
- Ensure its output is not dispatched to channels.
- Later, host can own scheduling/visibility if needed.

Acceptance checks:

- Background review never sends a chat message.
- It can create or patch a local skill.
- It can update journal or standing memory only through allowed files.
- If it crashes, the user-facing turn remains successful.
- Logs show a compact review summary.
- Risky or ambiguous candidates become internal proposals rather than direct writes.

## Phase 6: Curator

Add a periodic, idle-time curator after background review is stable.

Curator responsibilities:

- Review only agent-created local skills.
- Never touch shared/bundled skills.
- Respect `pinned: true`.
- Archive stale or low-value skills, never hard-delete.
- Consolidate narrow micro-skills into broader class-level skills.
- Snapshot before moving or editing skills.
- Restore or roll back bad skill updates.
- Flag skills that repeatedly fail or require frequent deviation.
- Keep skill files short enough to stay usable.

Suggested config defaults:

- Enabled: true.
- Run no more than once every 7 days per group.
- Only run after at least 2 hours of group inactivity.
- Consider stale after 30 days unused.
- Archive after 90 days unused if low value and not pinned.
- Keep 5 snapshots.

Snapshot path:

```text
groups/<folder>/skills/.snapshots/<timestamp>/
```

Commands/tools to add later:

- `skill_manage pin`
- `skill_manage unpin`
- `skill_manage archive`
- `skill_manage restore`
- possibly an admin-only `skill_curator_run`

Acceptance checks:

- Pinned skills are not archived.
- Shared skills are never modified.
- A snapshot is created before edits.
- Curator summary lists actions.
- Archived skills can be manually restored.
- Provenance is preserved through consolidation and rollback.

## Phase 7: Session Search

Hermes indexes sessions with SQLite FTS5 and summarizes matches. NanoClaw already archives conversations as markdown under:

```text
groups/<folder>/conversations/
```

Add search without disturbing the inbound/outbound session DB architecture.

Recommended storage:

```text
data/history.db
```

or per-group:

```text
groups/<folder>/.history/history.db
```

Prefer host-owned indexing first.

Schema sketch:

```text
history.db
  conversations
  messages
  snippets
  messages_fts
```

Index sources:

- Markdown files in `groups/<folder>/conversations/`.
- Later, delivered `messages_in` / `messages_out` rows if needed.

Add MCP tool:

```text
container/agent-runner/src/mcp-tools/session-search.ts
container/agent-runner/src/mcp-tools/session-search.instructions.md
```

Tool behavior:

- Query FTS index.
- Return matching conversation titles, dates, snippets, and file paths.
- Keep first version extractive only.
- Later add optional LLM summarization with a cheap auxiliary model.

Important:

- Do not let the container write the host-owned history DB unless that is deliberately designed.
- The MCP tool can read a mounted read-only index or call a host action.
- If easier, the first version can `rg` markdown files directly before introducing FTS.

Acceptance checks:

- Agent can search old conversations by keyword.
- Results include file paths and snippets.
- No session DB write contention is introduced.
- Search does not auto-import old journals into current context.
- Results are concise by default and avoid dumping whole transcripts into context.

## Phase 8: Provider and Cost Strategy

This plan should work with Claude first and Codex next.

Claude considerations:

- Claude Code already has native skills and hooks.
- `skill_manage` still adds validation and durable local-skill provenance.
- PreCompact currently archives transcripts.

Codex considerations:

- Install provider branch first if Codex is not present.
- Codex app-server should be used rather than a thin prompt wrapper.
- Codex needs explicit MCP config via `~/.codex/config.toml`.
- Codex may not load Claude-style skills exactly the same way, so `skill_view` matters.
- Mid-turn input is weaker and usually queues between turns.

Cost guidance:

- User-facing hard tasks can use the strongest available provider.
- Background review and curation should use cheaper auxiliary models when possible.
- Never let background self-improvement silently double the user's expensive model spend.
- Add counters/logging before enabling aggressive review intervals.

## Suggested Implementation Order

Do this in small commits or at least small working slices:

1. Add local skill discovery/symlinking.
2. Add `skill_view`.
3. Add `skill_manage create/edit/write_file/archive`.
4. Add validation tests.
5. Add `skills.instructions.md`.
6. Run a foreground canary.
7. Add usage/provenance sidecar.
8. Add background review as internal-only.
9. Add curator.
10. Add session search.
11. Tune provider/cost behavior.

Do not start with background automation. The foreground skill loop is the foundation.

## First Implementation Session Checklist

When starting implementation, do this first:

1. Check `git status --short` and avoid disturbing unrelated user changes.
2. Read this document.
3. Read `src/container-runner.ts`, `src/claude-md-compose.ts`, and `container/agent-runner/src/mcp-tools/*`.
4. Decide whether to implement only Phase 1 and Phase 2 in the first pass.
5. Add tests close to changed code.
6. Run `pnpm run typecheck`.
7. Run `pnpm run test:container` if container-side code changed.
8. Summarize exactly what was implemented and what remains.

## Definition of Done for MVP

MVP means:

- A group can have local skills under `groups/<folder>/skills/`.
- Local skills are exposed to the agent container.
- The agent can list, read, validate, create/edit/archive, and record use for local skills.
- The agent can create/edit/archive local skills through a validated MCP tool.
- The agent is instructed when to save procedures as skills.
- The system distinguishes memory, task files, skills, and session search.
- Dangerous skill content is rejected or escalated.
- Skill metadata records source turn/conversation, author, timestamps, status, and usage.
- Existing Claude behavior is not regressed.
- Inline after-action review is included in shared agent instructions.
- No separate background review is required for MVP.

Background review, curator, and session search are follow-up features.

## Source Links

- Hermes Agent: https://github.com/nousresearch/hermes-agent
- Hermes skills docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Hermes memory docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- OpenAI Codex App Server overview: https://openai.com/index/unlocking-the-codex-harness/
- OpenAI Codex CLI docs: https://developers.openai.com/codex/cli
