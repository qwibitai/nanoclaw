# Observer Agent — v0.2.0 Issue #1

## Progress
- [ ] Phase 1: Observer Core — LLM compression module
- [ ] Phase 2: Host Integration — wire into conversation lifecycle

## Purpose

After each substantial Discord conversation (5+ messages), an observer compresses the exchange into prioritized observations and appends them to `daily/{date}.md`. This gives the agent compressed, searchable memory that BM25 recall already picks up — better signal-to-noise than raw chat history.

A user who deploys Sovereign will see their agent automatically building a daily knowledge base from conversations, with critical decisions marked 🔴, useful context marked 🟡, and noise marked 🟢.

## Context & Orientation

**Sovereign** is a fork of NanoClaw — a Node.js host that runs Claude Code conversations inside Docker containers. The host (`src/index.ts`) receives Discord messages, spawns a container per conversation, streams results back to Discord, and manages state in SQLite (`store/messages.db`).

Key files for this feature:
- `src/index.ts` — `processGroupMessages()` is the main conversation handler. It formats messages, calls `runAgent()`, and handles the response. This is where we hook the observer.
- `src/container-runner.ts` — Spawns Docker containers. We do NOT modify this — the observer runs host-side, not in a container.
- `src/config.ts` — All config constants. We add observer settings here.
- `src/types.ts` — Shared TypeScript interfaces.
- `groups/{folder}/daily/` — Where observations are written. Already in the workspace, already searchable by BM25 recall.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — BM25 recall tool. Already searches all workspace files including `daily/`. No changes needed.

**How conversations flow today:**
1. Discord message → host stores in DB → formats as XML
2. Host spawns container → container runs Claude Code → streams results back
3. Host sends results to Discord → advances cursor → conversation done
4. **Nothing happens after step 3** — this is the gap the observer fills.

## Decisions

**Observer model: Sonnet 4.6** (not Haiku, not MiniMax). Haiku hallucinates — unacceptable for memory. MiniMax can't do structured tasks (known from deployment experience). Sonnet costs ~$0.03 per observation at $3/$15 per M tokens with ~2K tokens per call. At 5-10 conversations/day, that's $0.15-$0.30/day.

**Host-side direct API call** (not a container spawn). The observer is a single LLM call — no tools, no MCP, no agent loop. Spawning a container for this would add 10-15 seconds of overhead for no benefit. The host already has OpenRouter credentials in `.env`.

**Threshold: 5+ user messages**. Short exchanges (1-2 messages) don't have enough substance to observe. Scheduled tasks (crons) are auto-skipped because they're routine and rarely hit 5 messages.

**Append-only writes**. The observer NEVER overwrites or deletes existing content. It creates `daily/{date}.md` if missing, or appends below existing content. This prevents the #1 anti-goal: losing real memories.

**Fire-and-forget after response**. The observer runs AFTER the Discord response is sent. It doesn't await — a failed observation never blocks or delays a conversation. Failed = logged warning, move on.

## Milestones

### Phase 1: Observer Core (src/observer.ts, src/types.ts)

The goal is a standalone module that takes conversation messages and produces observations. After this phase, `observeConversation(groupFolder, userMessages, botResponses)` exists and can be called from anywhere.

The module makes a direct HTTP call to OpenRouter (Sonnet 4.6) with a compression prompt. The prompt instructs the LLM to:
- Extract key observations from the conversation
- Assign priority markers: 🔴 Critical (decisions, commitments, errors), 🟡 Useful (preferences, context), 🟢 Noise (pleasantries)
- Note referenced dates (three-date model from Mastra)
- Format as markdown sections with timestamps

Before sending to the LLM, conversation text is scrubbed for credentials (reusing the existing `scrubCredentials` pattern). After LLM returns, observations are appended to `groups/{folder}/daily/{date}.md`.

Safety: 30-second timeout on LLM call. Circuit breaker after 3 consecutive failures (logs error, returns silently). Kill switch via `OBSERVER_ENABLED` env var.

**Verify:** `npm run build` passes. Manual test: call `observeConversation()` with sample data, check daily file written correctly.

### Phase 2: Host Integration (src/index.ts, src/config.ts, .env.example)

The goal is to wire the observer into the conversation lifecycle. After this phase, every substantial conversation automatically triggers observation without any manual intervention.

In `processGroupMessages()`, after `runAgent()` returns successfully, we check: was this a real conversation (not a scheduled task)? Did it have 5+ user messages? If yes, call `observeConversation()` as a fire-and-forget promise (`.catch(err => logger.warn(...))`). The bot responses are accumulated during the streaming callback and passed alongside user messages.

Config additions: `OBSERVER_ENABLED` (default true), `OBSERVER_MIN_MESSAGES` (default 5), `OBSERVER_MODEL` (default `anthropic/claude-sonnet-4-6`). Added to `src/config.ts` and `.env.example`.

**Verify:** `npm run build` passes. BM25 recall search for a topic discussed in a conversation finds the observation in `daily/` files.

## Interfaces

**Phase 1 produces:**
```typescript
// src/types.ts
export interface ObservationEntry {
  time: string;           // ISO timestamp of observation
  topic: string;          // Brief topic summary
  priority: 'critical' | 'useful' | 'noise';
  points: string[];       // Key observations as bullet points
  referencedDates: string[]; // Dates mentioned in conversation
}

// src/observer.ts
export async function observeConversation(
  groupFolder: string,
  userMessages: Array<{ sender_name: string; content: string; timestamp: string }>,
  botResponses: string[],
): Promise<void>;
```

**Phase 2 consumes:** `observeConversation()` from Phase 1.

**Output format (daily/{date}.md):**
```markdown
## Observations — 2026-02-27

### 14:32 — Decided to use Sonnet for observer (🔴 Critical)
- Switched from MiniMax to Sonnet 4.6 for observation compression
- Haiku hallucinates — unacceptable for memory system
- Cost: ~$0.03 per observation, acceptable for quality
Referenced: 2026-02-27

### 15:10 — Email check results (🟢 Noise)
- No urgent emails found
- Newsletter from OpenAI about tool improvements
Referenced: 2026-02-27
```

## Risks & Mitigations

**Credential leakage into observations** is the highest-impact risk. If API keys or tokens appear in conversation text and get compressed into observations, they'd persist in workspace files. Mitigation: scrub all conversation text through `scrubCredentials()` before sending to the LLM. The same regex patterns that protect Discord messages protect observations.

**Cost spiral** is controlled by the 5-message threshold (skips most short interactions), skipping scheduled tasks (crons), and using a single LLM call per conversation (not an agent loop). At worst, 20 conversations/day × $0.03 = $0.60/day.

**LLM producing hallucinated observations** — fabricating decisions or commitments that didn't happen — is mitigated by using Sonnet 4.6 (reliable, same model that ran the conversation) and keeping raw messages in the database as ground truth. Observations are additive context, not the sole record.

**Observer blocking response delivery** is prevented by the fire-and-forget pattern. The observer promise is not awaited — it runs in the background after the Discord response is already sent.

## Validation

End-to-end proof: send 5+ messages to the Discord bot in a conversation. After the bot responds, check `groups/main/daily/{today}.md` — it should contain observations with priority markers and timestamps. Then use the `recall` tool to search for a topic from that conversation — it should find the observation.
