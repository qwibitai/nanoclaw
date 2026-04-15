# TODOS

## Chat Interface UX

### Cross-Source Thread Correlation

**What:** LLM-assisted grouping of items across sources (email + calendar + Discord = one "thread of work").

**Why:** Thread intelligence currently only uses Gmail thread IDs (same-thread grouping). Cross-source correlation (calendar attendees matching email senders, Discord thread mentioning email subject) would let the dashboard show "Acme Corp deal (3 items: email, calendar, contract)" instead of 3 separate items.

**Context:** Deferred from Phase 6 during CEO review. Gmail thread ID grouping ships in Phase 1. Cross-source correlation requires LLM calls to match items across sources, which risks false positives that damage trust. Ship simple, prove value, then add complexity. Start with: calendar event attendees matching email senders (high precision, no LLM needed). Then Discord thread subject matching (needs LLM).

**Effort:** L
**Priority:** P2
**Status:** ✅ Shipped
**Depends on:** Phase 1 (threads table, tracked_items with thread_id)

### Proactive Scheduling Intelligence

**What:** Suggest rescheduling based on calendar patterns and item urgency.

**Why:** If NanoClaw sees you have 3 action-required emails but back-to-back meetings until 4pm, it could suggest "You have a 30-min gap at 2pm, want me to hold these for then?" instead of pushing during meetings.

**Context:** Identified during CEO review brainstorming. Requires: calendar pattern analysis, gap detection, user preference learning. Builds on context-aware delivery (Phase 3) and learning loop (Phase 5). Don't attempt until both are shipped and validated.

**Effort:** L
**Priority:** P3
**Status:** ✅ Shipped
**Depends on:** Phase 3 (context-aware delivery), Phase 5 (learning loop)

### SSE-Triggered Classification

**What:** Bypass the 5-min email-poll cron by having the orchestrator classify emails directly when the email SSE detects new messages.

**Why:** Current end-to-end latency for email push notifications is ~5 minutes (5-min cron + container spin-up + IPC poll). The email SSE at src/email-sse.ts already detects new emails in real-time. If the orchestrator's classify() could act on SSE events directly (calling SuperPilot API without a container), email push latency drops from 5min to <5s.

**Context:** Outside voice flagged this during eng review. The plan claims "real-time push" but the architecture bottleneck is the container-based email-poll cycle. The orchestrator already has SuperPilot API access via config. Key risk: the container currently does more than just classify (it also processes emails, writes replies for AUTO actions). SSE-triggered classification would only handle the detection + push decision, not the action execution.

**Effort:** M
**Priority:** P2
**Status:** ✅ Shipped
**Depends on:** Phase 1 (src/classification.ts in orchestrator)

### Delegation Trust Taxonomy

**What:** Map "Handle It" delegation actions to trust engine action classes.

**Why:** The "Handle It" button (Expansion #9) needs trust engine integration for graduated autonomy (draft-then-approve for first N delegations, then AUTO). The current TOOL_CLASS_MAP at src/trust-engine.ts has 18 action classes (6 domains x 3 operations) but no "delegation" concept.

**Context:** Options: (a) new delegation domain with read/write/transact operations, (b) map to existing domains (email reply -> comms.write, calendar accept -> services.write, archive -> comms.read), (c) hybrid where delegation actions inherit their source's domain but get a special "delegated" flag. Option (b) is simplest and reuses existing confidence tracking. The "first 10 delegations" guardrail from the spec could be a separate counter, not tied to confidence thresholds.

**Effort:** S
**Priority:** P2
**Status:** ✅ Shipped
**Depends on:** None (design work, blocks Phase 3 implementation)
