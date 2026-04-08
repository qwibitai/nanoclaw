---
name: add-llm-failover
description: Add quota-aware multi-LLM failover to NanoClaw, including portable Codex home resolution and safe retry classification. Use when implementing Claude/Codex/OpenRouter switching, provider health tracking, or fallback behavior for rate-limit and auth failures.
---

# Add LLM Failover

This skill packages the NanoClaw engine-switch work into a repeatable change set.
Use it when you want the bot to route between Claude, Codex, and future fallback providers without leaking user-specific paths or treating provider errors as successful assistant text.

## What This Skill Covers

- Ordered provider chains with deterministic fallback
- Retry classification for quota, rate-limit, auth, transport, and config failures
- Structured provider-failure propagation from container to host
- Portable Codex home resolution using the host home directory, not a hardcoded username
- Validation for both repo code and the live canary install

## Phase 1: Preflight

Check the target worktree first.

```bash
git status --porcelain
git branch --show-current
```

If you are updating the PR branch, use the clean `pr-963` worktree.
If you are updating the live install, make sure you are not about to overwrite unrelated local edits.

Confirm the current failover state:

- `src/engine-switch.ts` exists and already classifies provider failures
- `src/container-runner.ts` preserves structured stdout on nonzero container exit
- `container/agent-runner/src/runtime/claude-runtime.ts` turns repeated `system/api_retry` into a provider failure

If any of those pieces are missing, add them before polishing anything else.

## Phase 2: Implement Provider Switching

### 1. Keep provider selection explicit

Maintain an ordered provider chain:

- Claude first for normal traffic
- Codex as the immediate fallback
- OpenRouter or other pay-per-token providers later as additional links in the chain

Do not infer provider choice from assistant text.
Only switch on structured failure metadata or a bounded runtime retry exhaustion.

### 2. Classify provider failures

Treat these as switch triggers when they happen before user-visible output:

- `rate_limit`
- `quota`
- `auth`
- `transport`
- `config`

In the Claude runtime, convert repeated `system/api_retry` into a bounded `transport` failure.
If the SDK surfaces 401/auth text or rate-limit text as structured events, classify those too.

### 3. Preserve structured exit output

If the container exits nonzero but stdout contains a valid JSON result with `providerFailureClass`, keep that structured payload.
Do not discard it and fall back to stderr text.

### 4. Make Codex home portable

Never hardcode `/home/<user>/.codex`.

Use the host home directory to derive the path:

```ts
const CODEX_HOME = path.join(os.homedir(), '.codex');
```

Then:

- mount that path into the container at the same absolute path
- pass `NANOCLAW_CODEX_HOME` into the container env
- in the Codex runtime, resolve `CODEX_HOME` from `NANOCLAW_CODEX_HOME`, then `process.env.HOME`, then `/home/node`

This keeps the PR portable across machines and prevents username leakage in review.

### 5. Keep live session copies in sync

If the live install copies `container/agent-runner-src` into `data/sessions/<group>/agent-runner-src`, refresh that copy or restart the service after runtime changes.

Otherwise the live bot may keep using stale runtime code even after the repo is fixed.

## Phase 3: Validation

Run the focused checks first, then the broader build.

```bash
npm exec vitest run src/container-runner.test.ts src/engine-switch.test.ts src/task-scheduler.test.ts
npm run typecheck
npm run build
npm --prefix container/agent-runner run build
```

If you changed the live install too, rebuild there as well and restart the service.

## Phase 4: Canary Check

Verify the behavior in production-like conditions:

- Trigger a Claude quota or auth failure
- Confirm the host logs `Provider failure, switching engine`
- Confirm the retry lands on Codex
- Confirm the bot replies instead of lingering on a dead provider

If the canary still fails on Codex startup, check the mounted `CODEX_HOME` path first.

## PR Notes

When the change is ready, link this skill from the PR thread so reviewers can see the intent behind the implementation.
Mention:

- provider-chain failover
- structured failure propagation
- portable Codex home
- stale runtime copy refresh, if applicable

