# Milestone 5: Telegram Delivery Track
**Created**: 29 March 2026 | **Target**: 6 April 2026 | **Project**: LearnClaw

## Objective
Open a second delivery path on Telegram so LearnClaw can move from purely self-hosted operator-driven usage toward a real learner-facing channel.

## Acceptance Criteria
1. Telegram can act as a learner-facing channel without breaking the self-hosted main-group control path.
2. Onboarding, learner-state files, and managed heartbeat scheduling work on Telegram-backed learner groups or chats.
3. Telegram-specific formatting and auth/setup flow are documented and testable.
4. The milestone does not compromise the isolation model between learner groups.

## Approach
Keep the product boundary tight. Reuse the existing channel architecture and the file-first learning workflow from Milestone 2. Do not build the full multi-tenant business yet; just prove a Telegram learner can be onboarded, coached, and scheduled through the same operating model.

## Files Affected
- Telegram channel integration files under `src/channels/`
- `src/index.ts`
- setup/auth documentation and flows
- `groups/global/CLAUDE.md`
- Telegram-specific tests and docs

## Tests Required
- Verify Telegram messages enter the same learner workflow as current self-hosted groups.
- Verify trigger behavior, onboarding injection, and heartbeat sync all function on Telegram-owned JIDs.
- Run `npm run typecheck` and `npm test`.

## Out of Scope
- Full SaaS multi-tenancy.
- Billing, admin panels, or cloud orchestration.
- Telegram swarm or multi-bot team features.

## Dependencies
- Milestone 2 complete and stable.
- A decision to prioritize distribution over deeper self-hosted pedagogy work.

## Fundability / Demo Value
This milestone is the first real distribution move. It changes the story from "self-hosted learning OS" to "a learning product that can reach actual users in a live channel."