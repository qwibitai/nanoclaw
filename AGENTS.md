# AGENTS.md

Project instructions for any agent working on this repo, regardless of
tool. Whether you're Claude Code, Codex, or something else, **start by
reading [`CLAUDE.md`](./CLAUDE.md)** — it has the architecture,
file-by-file map, conventions, supply-chain rules, runtime split, and
gotchas. Everything in CLAUDE.md applies to you too; nothing about
NanoClaw's structure depends on which model is editing.

@./CLAUDE.md

## Tool-specific notes for Codex

The repo was originally written with Claude Code in mind, so a few
patterns reference its tool model. Equivalents under Codex:

- **Editing files**: use `apply_patch`. The repo's project rule
  "ALWAYS prefer editing existing files; NEVER create new files
  unless required" applies the same way — `apply_patch` is for
  in-place edits; new files only when the task genuinely needs them.
- **Reading files**: `cat` / `head -N` / `sed -n 'A,Bp'` via shell are
  fine. CLAUDE.md mentions a "Read tool" — that's Claude Code's
  built-in. Plain shell does the same job.
- **Searching**: use ripgrep (`rg`) directly. CLAUDE.md mentions a
  "Grep tool"; Codex doing `rg "pattern" src/` from bash is the
  equivalent and matches Codex's bash-first design intent.
- **Planning**: CLAUDE.md's "Plan Before Executing" rule (write
  `plans/<feature>.md` before non-trivial work) applies. Codex's
  `update_plan` tool is for the in-session plan widget, not a
  replacement for the `plans/*.md` file — write the on-disk plan as
  well, since it survives across sessions.
- **MCP tools**: this codebase IS an agent platform, so the
  agent-runner's own MCP-tool surface lives at
  `container/agent-runner/src/mcp-tools/`. Editing those is normal
  source work — same `apply_patch` flow.

## Pre-commit hook quirk

The repo runs `prettier --write` via a pre-commit hook. After your
commit, prettier may reformat staged files and leave the formatted
output **uncommitted** (the hook re-saves but doesn't re-stage).
Symptom: `git status` after commit shows a diff. Fix: commit a
follow-up `chore: apply prettier formatting` with the leftover diff.
This isn't Codex-specific but it bites every agent that doesn't
expect it. Several commits in `git log` will have this pattern as
precedent.

## Pushing

Push proactively at phase boundaries, not at the end of long sessions
— see `~/.claude/projects/-home-nano-nanoclaw/memory/feedback_push_proactively.md`
for why. (Codex doesn't read that file; the rule is just: don't let
local main accumulate more than ~5 substantive commits ahead of
origin/main without flagging it.)

## Things that don't change between Codex and Claude Code

- The architecture (host process + per-session containers + two-DB session split).
- Where files live and what they do (CLAUDE.md's file map).
- The "no stash, use commit-WIP / worktrees" rule.
- The supply-chain policy (`minimumReleaseAge`, `onlyBuiltDependencies`,
  `--frozen-lockfile` in CI).
- The container vs host runtime split (Bun container, Node host).
- The branch model (`main` for trunk; `classroom`, `gws-tool`,
  `channels`, `providers` as long-lived sibling branches that skills
  install from).
