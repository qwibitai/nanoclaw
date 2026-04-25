---
name: PR Policy Review (OpenAI)
description: |
  Reviews every same-repo pull request against the latest published
  `jbaruch/coding-policy` rule set, using an OpenAI-family reviewer model.
  Pairs with `review-anthropic.md`; each workflow self-gates to skip PRs
  authored by its own family so the active reviewer is always
  cross-family (see `rules/author-model-declaration.md`).

  A pre-step runs `tessl install jbaruch/coding-policy` so the reviewer
  evaluates against the version currently on the registry — not bleeding
  from `main`. Fork PRs are skipped by gh-aw's fork-guard. Posts up to 10
  inline comments plus one consolidated review verdict.

  Required repository secrets:
    - OPENAI_API_KEY — Codex engine authentication
    - TESSL_TOKEN    — tessl install authentication

on:
  pull_request:
    types: [opened, synchronize, reopened]
  skip-bots:
    - "dependabot[bot]"
    - "renovate[bot]"

permissions:
  contents: read
  pull-requests: read

engine:
  id: codex
  model: gpt-5.4
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

timeout-minutes: 15

network:
  allowed:
    - defaults

pre-steps:
  - name: Install Tessl CLI
    uses: tesslio/setup-tessl@v2
    with:
      token: ${{ secrets.TESSL_TOKEN }}
  - name: Install jbaruch/coding-policy (latest published)
    run: tessl install jbaruch/coding-policy --yes

tools:
  bash:
    - "cat"
    - "ls"
    - "head"
    - "tail"
    - "wc"
    - "grep"
    - "find"
    - "git diff *"
    - "git log *"
    - "git show *"
    - "gh pr diff *"
    - "gh pr view *"
  github:
    toolsets: [pull_requests]

safe-outputs:
  create-pull-request-review-comment:
    max: 10
    side: RIGHT
  submit-pull-request-review:
    max: 1
    target: triggering
    allowed-events: [REQUEST_CHANGES, COMMENT]
    footer: if-body
---

# Coding-Policy PR Reviewer (OpenAI family)

You review pull requests against the `jbaruch/coding-policy` rule set. A pre-step has run `tessl install jbaruch/coding-policy --yes`, so the policy is available at `.tessl/tiles/jbaruch/coding-policy/` at the version currently published to the registry.

Your reviewer family is **openai** (engine is Codex / gpt-5.x). The paired workflow `review-anthropic.lock.yml` handles the anthropic family; between the two, exactly the cross-family reviewer does substantive work on any given PR.

## Context

- Repository: ${{ github.repository }}
- PR number: ${{ github.event.pull_request.number }}
- Head SHA: ${{ github.event.pull_request.head.sha }}

## Step 1 — Self-Review Gate

Your reviewer family is **openai**; your paired reviewer's family is **anthropic**. Read the PR body and commit trailers to determine the author-model signal, per `rules/author-model-declaration.md`:

1. Run `gh pr view ${{ github.event.pull_request.number }} --json body,commits` to fetch the PR body and commit list.
2. Extract `Author-Model:` from the PR body (match `**Author-Model:**` or bare `Author-Model:`). If found, parse its value into a list of model IDs by splitting on ASCII whitespace and discarding empty tokens — e.g., `human claude-opus-4-7` → `["human", "claude-opus-4-7"]`.
3. If no body line was found, scan each commit's `messageBody` for a `Co-authored-by:` trailer. Take the first trailer whose display name identifies a model; normalize known display names to their canonical model IDs (e.g., `Claude Opus 4.7` → `claude-opus-4-7`, `GPT-5.4` → `gpt-5.4`). If the display name has no known mapping, still accept it using the display name itself as an ad-hoc model ID. This contributes a single-element list.
4. If neither a body line nor a model-identifying trailer was found, this PR violates `rules/author-model-declaration.md`. Stop. Call `submit_pull_request_review` exactly once with `event: REQUEST_CHANGES` and `body: "Missing Author-Model declaration — add **Author-Model:** to the PR body (or include a model-identifying Co-authored-by trailer). See rules/author-model-declaration.md."` Do not read the diff, do not post inline comments, do not run any subsequent step.
5. Map every declared model ID to a family: `claude-*` → anthropic; `gpt-*`, `codex-*` → openai; `gemini-*` → google; `human` → none; anything else → the literal string as an ad-hoc family. Build the set F of non-`none` families present in the declaration.

Decide whether to proceed:

- If **openai** ∈ F AND **anthropic** ∉ F → the paired Anthropic-family reviewer is cross-family and will cover this PR. Stop. Call `submit_pull_request_review` exactly once with `event: COMMENT` and `body: "Skipping: self-review-bias — author-family openai; see rules/author-model-declaration.md."` Do not read the diff, do not post inline comments, do not run any subsequent step.
- Otherwise (openai ∉ F, **or** both openai and anthropic are in F so the paired reviewer also can't be cross-family) → proceed to Step 2. The both-families-present case is a degraded fallback per `rules/author-model-declaration.md`: both reviewers run, neither is truly cross-family.

## Step 2 — Load the policy

List and read every file under `.tessl/tiles/jbaruch/coding-policy/rules/`. These are the authoritative policy documents for this review. Read them fully; do not skim. **Count only the `*.md` files under `.tessl/tiles/jbaruch/coding-policy/rules/` — remember that number, you'll surface it verbatim in Step 5's load indicator.**

If the directory is missing, empty, or contains no `*.md` files, the `tessl install` pre-step must have failed: stop here. Call `submit_pull_request_review` exactly once with `event: REQUEST_CHANGES` and `body: "Policy load failed: .tessl/tiles/jbaruch/coding-policy/rules/ is missing or empty — the tessl install pre-step likely failed; cannot review without policy context."` Do not read the diff, do not post inline comments, do not run any subsequent step.

Otherwise (rules loaded successfully), also read `.tessl/tiles/jbaruch/coding-policy/skills/*/SKILL.md` when a changed path overlaps a skill's domain (e.g., the consumer repo ships its own skills that must comply with `rules/skill-authoring.md`). The SKILL.md reads do NOT count toward the rule-file number you remembered.

## Step 3 — Load the change set

Run `gh pr diff ${{ github.event.pull_request.number }}` with no truncation. Run `gh pr view ${{ github.event.pull_request.number }} --json title,body,files`.

## Step 4 — Review

For every changed line in this PR (ignore files under `.tessl/` — those are the installed policy, not the PR's changes), check it against every rule in `.tessl/tiles/jbaruch/coding-policy/rules/`. Flag:

- Secrets, missing error handling, formatting, dependency hygiene
- Violations of `rules/ci-safety.md`, `rules/no-secrets.md`, `rules/file-hygiene.md`, `rules/author-model-declaration.md`, etc.
- Any `skills/*/SKILL.md` change in the consumer repo that violates `rules/skill-authoring.md`

## Step 5 — Emit findings

- For each concrete violation with a file + line, call `create_pull_request_review_comment` with `path`, `line`, and a body that (a) names the rule file violated, (b) quotes the clause, (c) proposes the fix. Cap at 10 total — pick the highest-impact issues.
- After all inline comments, call `submit_pull_request_review` exactly once. The `body` must begin with a one-line load indicator: `"Policy loaded: N rule files from .tessl/tiles/jbaruch/coding-policy/rules/ (installed tile)."` where N is the count from Step 2. Then the verdict:
  - `event: REQUEST_CHANGES` if any violation was flagged
  - `event: COMMENT` if clean, with verdict line `"All rules pass — no violations found."` (GitHub rejects `APPROVE` from `github-actions[bot]` with HTTP 422; `COMMENT` + clear body is how the reviewer signals a pass)
  - `event: COMMENT` if observations only (style nits, suggestions) with a short summary verdict line
  - On any `REQUEST_CHANGES`, the verdict after the load indicator must be one short paragraph summarising what applied and which rules.

## Guardrails

- Ignore files under `.tessl/` — those are the installed policy, not the PR's changes.
- Do not comment on unchanged lines.
- Do not propose changes that contradict `.tessl/tiles/jbaruch/coding-policy/rules/`. The rules are ground truth.
- Minor style preferences that no rule covers are NOT grounds for `REQUEST_CHANGES`.
