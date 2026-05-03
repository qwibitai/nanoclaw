# Baget Channel Gemini Provider Plan

## Goal

Path B1 handoff follow-through: replace the default Bun-incompatible Claude runner path with a Bun-compatible Gemini provider so a paired founder DM can reach the agent runner and receive a real reply.

## Plan

- [x] Review the handoff, current branch state, provider interface, and local experimental diffs.
- [x] Add tests for Gemini provider behavior and provider registration before changing runtime logic.
- [x] Implement `container/agent-runner/src/providers/gemini.ts` with persisted conversation continuation.
- [x] Wire the provider into the barrel/factory, add the runtime dependency, and switch the Baget template default provider to `gemini`.
- [x] Decide whether the local Claude/Bun experimental shims remain necessary once Gemini is the default path, and remove any superseded pieces if safe.
- [x] Run `npm run typecheck` and `npm test` in `container/agent-runner`, then run the repo checks needed for touched code.
- [x] Run focused review passes for the new external API integration and record findings.

## Notes

- Keep the change scoped to unblocking the Baget Telegram flow; tool-calling parity with the Claude SDK is out of scope for this pass.
- Prefer `GOOGLE_GENERATIVE_AI_API_KEY`, then `GOOGLE_AI_API_KEY`, mirroring existing Baget conventions.
- Use a stable Gemini Flash model default that matches current Baget usage unless the repo already dictates otherwise.

## Review

- Verification:
- `container/agent-runner`: `npm run typecheck`
- `container/agent-runner`: `npx bun@1.2.20 test`
- repo root: `npm run typecheck`
- repo root: `npm test`
- Follow-up verification plan:
- [x] Re-check the deployed staging health endpoint and admin contract.
- [x] Attempt a local or deployed smoke path for the Gemini-backed runner.
- [x] Record the first blocking environment gap if full E2E cannot be completed from this shell.
- Extra verification:
- repo root: `npm test -- --run src/channels/baget-telegram.test.ts`
- staging: `GET /healthz` returned `{"ok":true}`
- staging: `POST /baget/agent-groups` returned 200 and minted a fresh deep link
- staging: synthetic `/start` + plain DM webhook posts both returned 200; cleanup `DELETE /baget/agent-groups` returned 200

- Findings:
- No blocker or high-severity issues found in the final diff.
- `runPollLoop()` previously had no clean shutdown path for tests; adding optional `AbortSignal` support fixed a pre-existing background-interval leak and made the suite deterministic.
- Live staging smoke exposed a separate regression in `GET /baget/agent-groups/by-tuple`: `firstBoundChatId()` was still querying removed `messaging_groups.platform` / `platform_chat_id` columns, so a successfully paired founder chat caused a 500. Fixed locally by reading the current `channel_type` / `platform_id` shape and covered with a new shared-listener webhook test.
- Remaining blocker for true deployed Gemini verification: Railway CLI auth is expired in this shell (`railway status` / `railway variables` both return unauthorized), so I cannot deploy this local fix set or inspect live logs from here. The local and test-level Gemini path is green; staging still runs the older deployed build until that auth is restored.
- Residual risk: Gemini continuations serialize the full curated chat history into `session_state`, so very long chats will grow the stored payload over time. Acceptable for this unblocker, but worth watching in staging logs and DB size.

## Follow-Up: Staging Env Passthrough

- [x] Verify the Railway staging service variables before blaming missing-key logs.
- [x] Ensure the host-side provider registry imports Gemini and forwards Google auth/model env vars into the single-process child runner.
- [x] Re-run local checks, redeploy, and confirm the live founder DM path produces a real Gemini-backed reply.

## Follow-Up Review

- Additional verification:
- repo root: `npm run typecheck`
- repo root: `npm test` (`31` files, `274` tests)
- staging service vars: both `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_AI_API_KEY` are present on Railway
- staging deploy: `pass gemini env into single-process runner` reached `SUCCESS`
- staging synthetic founder flow: `POST /baget/agent-groups` → 200, synthetic `/start` webhook → 200, `GET /baget/agent-groups/by-tuple` → paired true, synthetic DM webhook → 200
- staging live logs: runner now boots as `provider: gemini`, poll-loop processed the founder DM, and the session DB shows a completed inbound row plus an outbound reply row

- Findings:
- The “Gemini key missing” staging failure was not a Railway config issue. The service had the keys, but the single-process child runner never received them because `src/providers/index.ts` did not import any host-side provider registrations.
- Adding `src/providers/gemini.ts` plus explicit barrel imports fixed the live blocker without widening the child env beyond the existing allowlist model.
- Residual nuance: the synthetic Gemini-generated reply did not include the role-tag format (`cos: ...`) that the Telegram adapter turns into a visible persona prefix. The runner path is unblocked and replying, but this specific smoke did not prove final `🧭 Louis:` formatting from model output alone.

## Follow-Up: Persona Prompt Wiring

- [x] Load the rendered workspace prompt files into Gemini's system instruction instead of relying on runtime addendum only.
- [x] Stop stamping Baget company names into `assistantName` so founder groups stay team-shaped instead of self-identifying as the company.
- [x] Re-run local checks, redeploy staging, and verify deployed outbound replies stay in persona.

## Persona Prompt Review

- Additional verification:
- `container/agent-runner`: `npm run typecheck`
- `container/agent-runner`: `npx bun@1.2.20 test src/system-prompt.test.ts src/providers/gemini.test.ts src/integration.test.ts`
- repo root: `npm run typecheck`
- repo root: `npm test -- --run src/container-runner.test.ts src/channels/baget-telegram.test.ts src/providers/index.test.ts`
- staging deploy: `use baget persona prompt for gemini replies` reached `SUCCESS`
- staging synthetic founder flow: create group → `/start` pair → tuple lookup → founder DM all returned `200`
- staging runtime verification:
- remote `CLAUDE.local.md` for the fresh Baget group contains the six-role founder prompt
- remote `container.json` no longer includes `assistantName` for Baget groups
- remote `outbound.db` reply to `what is our company?` was `cos: We are a company building an AI-powered co-founder...`
- remote `outbound.db` reply to `what model are you?` was `cos: I am your AI team, running on Baget...`
- cleanup: archived the synthetic staging group and unbound its test chat

- Findings:
- The real bug was not just provider selection; Gemini was only seeing the runtime routing addendum, so it never received the Baget persona contract from `CLAUDE.local.md`.
- Baget founder groups should not set `assistantName` to the company name. Leaving it unset lets the role-tag prompt drive the visible persona layer instead of forcing “I am <company>” behavior.
- Reading back the deployed `outbound.db` is a reliable way to verify founder-facing persona behavior without waiting on a manual Telegram screenshot.
