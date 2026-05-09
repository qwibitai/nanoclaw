import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
  getStickyModel,
  setStickyModel,
  clearStickyModel,
  getStickyEffort,
  setStickyEffort,
  clearStickyEffort,
} from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { autoCommitDirtyWorktrees } from './worktree-autosave.js';
import { buildSessionRecap, wrapRecap } from './session-recap.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question).
    // Exception: recall_context system messages must reach the prompt path so the agent sees recalled facts.
    const messages = getPendingMessages().filter((m) => {
      if (m.kind !== 'system') return true;
      try {
        const parsed = JSON.parse(m.content) as { subtype?: string };
        return parsed.subtype === 'recall_context';
      } catch {
        return false;
      }
    });
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    //
    // Note on claim ordering: we used to markProcessing(ids) up front,
    // then run pre-task scripts. If a script gated all non-command rows,
    // any trigger=0 chat in the batch would stay 'processing' until the
    // host stale-claim sweep cleared it (~60s). Now we claim only the
    // rows that will actually reach the prompt — same pattern as the
    // in-turn helper.
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    // Re-validate post-script: if no admissible trigger survives, defer
    // the surviving trigger=0 context rows for the next iteration. Don't
    // claim them — leaving rows pending is the correct signal that they
    // weren't consumed. (Mirrors selectInTurnFollowUps' deferral logic.)
    if (!keep.some(isAdmissibleTrigger)) {
      log(`All ${normalMessages.length} non-command message(s) gated by script or no admissible trigger, skipping query`);
      continue;
    }

    // Claim only the rows that will actually reach the prompt.
    const keptIds = keep.map((m) => m.id);
    markProcessing(keptIds);

    const { model: effectiveModel, effort: effectiveEffort } = applyFlagBatch(keep, routing);

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(
      `Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}` +
        (effectiveModel ? ` model=${effectiveModel}` : '') +
        (effectiveEffort ? ` effort=${effectiveEffort}` : ''),
    );

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      model: effectiveModel,
      effort: effectiveEffort,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages.
    // processingIds == keptIds now: commands were marked completed inline,
    // skipped task rows were marked completed by the pre-task block, and
    // we only claimed the rows that actually reach the prompt.
    const processingIds = keptIds;
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      let recovered = false;

      // Retryable-upstream recovery: 429 / rate limit / overloaded /
      // upstream_error / subscription quota exhausted. If the provider has
      // fallback credentials configured (ANTHROPIC_API_KEY_N or
      // CLAUDE_CODE_OAUTH_TOKEN_N), rotate and retry once in-turn. Without
      // fallbacks OR once they're exhausted, fall through to the error
      // write. Ordered before isContextTooLong because prompt-too-long can
      // LOOK retryable in some error shapes, and the rotation cost is low.
      const rotation = config.provider.isRetryable?.(err)
        ? config.provider.rotateApiKey?.()
        : undefined;
      if (rotation?.rotated) {
        // Continuation is preserved across rotations: the SDK's `resume:`
        // reads a local .jsonl, and the Anthropic API has no account-bound
        // session object — the new credential just signs the next request.
        log(`Upstream transient error — rotated credential, retrying same prompt in-turn`);
        try {
          const retryQuery = config.provider.query({
            prompt,
            continuation,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation && retryResult.continuation !== continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after credential rotation also failed: ${retryMsg}`);
        }
      }

      // Context-window recovery: session grew past the model's limit.
      // Clear the continuation AND retry the same prompt once with a
      // fresh session, mirroring v1's silent prompt_too_long auto-
      // recovery (src/index.ts:2132-2199 — v1 also retried exactly once;
      // a second failure surfaced to the user same as we do here).
      //
      // Gated on `continuation` because a freshly-started session can't
      // be "too long" — if a user's first message is already over the
      // limit (e.g. a huge paste), the error falls through to the
      // isSessionInvalid branch (no retry) and lands as an error chat.
      // Not ideal for that edge case, but the alternative (retrying
      // without continuation) is what we'd do anyway, and the chat-error
      // pattern makes the failure explicit to the user.
      //
      // Recap from the per-session DB tells the agent what was just
      // discussed so it doesn't lose the thread. The marker is for the
      // case where there's no recap (no completed messages yet).
      if (!recovered && continuation && config.provider.isContextTooLong?.(err)) {
        log(`Context-too-long detected — clearing session and retrying once with fresh continuation`);
        continuation = undefined;
        clearContinuation(config.providerName);
        try {
          const recap = buildSessionRecap();
          const retryPrompt =
            (recap
              ? wrapRecap(recap, 'context-window-exceeded')
              : '[The prior session exceeded the model context window and was reset. Continuing fresh from here.]\n\n') +
            prompt;
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after context-too-long also failed: ${retryMsg}`);
          // The failed retry's `init` event may have re-persisted a
          // continuation. Clear it again so the next turn starts clean.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      } else if (!recovered && continuation && config.provider.isSessionInvalid(err)) {
        // Stale/corrupt continuation — most often a transcript .jsonl
        // that got pruned out from under us, or a session id that was
        // valid in a prior container but doesn't exist in this one's
        // ~/.claude/projects/. Clear and retry once with a recap from
        // the per-session DB so the user doesn't have to re-send and
        // doesn't lose conversational context.
        log(`Stale session detected (${continuation}) — clearing and retrying with recap`);
        continuation = undefined;
        clearContinuation(config.providerName);
        try {
          const recap = buildSessionRecap();
          const retryPrompt =
            (recap
              ? wrapRecap(recap, 'stale-session-recovered')
              : '[The prior agent session transcript was unavailable and could not be resumed. Starting a fresh session.]\n\n') +
            prompt;
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after stale-session recovery also failed: ${retryMsg}`);
          // The failed retry's `init` event may have re-persisted a
          // continuation. Clear it again so the next turn starts clean.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // Only surface the error to the user if we couldn't recover inline.
      if (!recovered) {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `Error: ${errMsg}` }),
        });
      }
    } finally {
      // Always clear the per-batch in_reply_to so MCP tools don't stamp
      // stale routing on the next turn (a2a return-path safety).
      clearCurrentInReplyTo();
    }

    // Per-turn safety net: checkpoint any uncommitted worktree edits so the
    // agent's work survives compaction or a later container kill even if
    // the agent forgot to commit. Mirrors v1's turn-end auto-commit pattern
    // (src/container-runner.ts cleanupThreadWorkspace, pre-fork). Never
    // throws; logs inside autoCommitDirtyWorktrees.
    const autosave = await autoCommitDirtyWorktrees('turn end');
    if (autosave.committed.length > 0 || autosave.failed.length > 0) {
      log(
        `autosave: committed=[${autosave.committed.join(',')}] failed=[${autosave.failed.join(',')}] skipped=${autosave.skipped.length}`,
      );
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${processingIds.length} message(s) (commands=${commandIds.length}, skipped=${skipped.length})`);
  }
}

/**
 * Predicate for "this row is a real wake trigger" — non-system, trigger=1,
 * not a /clear chat command. Used by both the in-turn admission helper and
 * the post-pre-task re-validation step.
 */
export function isAdmissibleTrigger(m: MessageInRow): boolean {
  if (m.trigger !== 1) return false;
  if (m.kind === 'system') return false;
  if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
  return true;
}

/**
 * Decide which pending rows to admit as a mid-turn follow-up push to an
 * in-flight query. Pure function — no DB writes — so tests can exercise
 * it directly without spinning a poll loop.
 *
 * Rules:
 * - Defer entirely (return []) when no row would survive admission as a
 *   real wake trigger. Survivors are trigger=1 chat/chat-sdk that aren't
 *   /clear, plus trigger=1 of other non-system kinds (task, webhook).
 *   /clear and non-recall system rows are NOT real triggers — letting
 *   them gate ride-along would push trigger=0 context with no actual
 *   user message in the prompt.
 * - When at least one survivor exists, admit:
 *     - chat / chat-sdk (any trigger; formatter wraps trigger=0 in
 *       <thread_context>; /clear excluded)
 *     - non-system other kinds, trigger=1 only
 *     - recall_context system rows whose paired trigger id is in the
 *       surviving-triggers set
 * - All other system rows are dropped.
 */
export function selectInTurnFollowUps(allPending: MessageInRow[]): MessageInRow[] {
  const isChatRow = (m: MessageInRow): boolean => m.kind === 'chat' || m.kind === 'chat-sdk';
  const triggerIds = new Set(allPending.filter(isAdmissibleTrigger).map((m) => m.id));
  if (triggerIds.size === 0) return [];

  return allPending.filter((m) => {
    if (m.kind === 'system') {
      try {
        const parsed = JSON.parse(m.content) as { subtype?: string };
        if (parsed.subtype !== 'recall_context') return false;
      } catch {
        return false;
      }
      const pairedTriggerId = m.id.startsWith('recall-') ? m.id.slice('recall-'.length) : null;
      return pairedTriggerId !== null && triggerIds.has(pairedTriggerId);
    }
    if (isChatRow(m) && isClearCommand(m)) return false;
    if (isChatRow(m)) return true;
    return m.trigger === 1;
  });
}

// Invariant: the `recall-` prefix is reserved for host-side recall-injection
// (src/modules/memory/recall-injection.ts). Platform message ids written by
// router.ts always carry the shape `<platform-baseId>:<agentGroupId>`; no
// adapter produces baseIds starting with `recall-`, so the strip below
// cannot collide with a real inbound id. Keep this contract — adding an
// adapter that breaks it would silently corrupt recall pairing.

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  // Slash commands push the active stream toward end-of-turn so the outer loop
  // can dispatch them through the canonical command path. Once we've decided to
  // end, gate further polling so we don't reclaim the rows mid-teardown.
  let endedForCommand = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const allPending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's resume
        // id (fixed at sdkQuery() time); admin/passthrough commands (/compact,
        // /cost, …) only dispatch when they're the first input of a query —
        // pushed mid-stream they arrive as plain text and the SDK never runs
        // them. End the stream and leave the rows pending; the outer loop
        // handles them via the canonical command path + formatMessagesWithCommands.
        if (allPending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Filtering on thread_id here caused deadlocks when the initial batch
        // and follow-ups had mismatched thread_ids (e.g. a host-generated welcome
        // trigger with null thread vs a Discord DM reply); per-thread sessions
        // already isolate threads, so the router's routing is sufficient.
        //
        // Admission rules live in selectInTurnFollowUps so they can be unit-
        // tested. Defers (returns []) when no admissible trigger=1 row is
        // present in the snapshot; otherwise admits accumulated trigger=0
        // chat context plus paired recall_context. The helper also drops
        // system rows except recall_context, replacing the older `kind !==
        // 'system'` filter from upstream's poll-loop.
        const candidates = selectInTurnFollowUps(allPending);
        if (candidates.length === 0) return;

        // Run pre-task scripts BEFORE claiming rows. A scripted task with
        // wakeAgent=false can drop the only admissible trigger from the
        // batch; if we'd already markProcessing'd the trigger=0 chat
        // context, those rows would be hidden behind processing acks even
        // though they were never sent to the agent. Deferring the claim
        // lets us walk away cleanly when no real trigger survives.
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(candidates);
        const keep: MessageInRow[] = preTask.keep;
        const skipped: string[] = preTask.skipped;
        // MODULE-HOOK:scheduling-pre-task-followup:end

        // Re-validate post-script: if the only admissible trigger was a
        // task that the script gated, keep would be trigger=0 chat (and
        // possibly orphaned recall_context). Don't push context-only into
        // an active stream — defer it for the next real wake. Skipped task
        // IDs still get marked completed so the script is not re-run.
        if (!keep.some(isAdmissibleTrigger)) {
          if (skipped.length > 0) {
            markCompleted(skipped);
            log(`Pre-task script skipped ${skipped.length} follow-up task(s); no admissible trigger remained, deferring context rows`);
          }
          return;
        }

        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work.
        if (done) {
          if (skipped.length > 0) markCompleted(skipped);
          return;
        }

        const keptIds = keep.map((m) => m.id);
        markProcessing(keptIds);
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        const prompt = formatMessages(keep);
        // Refresh the per-batch in_reply_to so MCP send_message stamps
        // outbound rows with the follow-up batch's anchor, not the outer
        // turn's. Without this, an a2a inbound pushed mid-turn has its
        // reply routed back to the outer-turn source session, which can
        // be a different session in a different mg.
        const followUpRouting = extractRouting(keep);
        setCurrentInReplyTo(followUpRouting.inReplyTo);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A `result` event signals the assistant's turn is complete, but the
        // provider's events generator stays open for follow-up `push()` calls
        // (see container/agent-runner/src/providers/claude.ts:1080 — the
        // generator only exits on `stream.end()`/abort). We must NOT flip
        // the `done` flag here; the polling interval depends on `done` to
        // gate follow-up admission, and stopping it after the first result
        // would
        // starve every subsequent inbound trigger=1 row in this session
        // (codex F4, 2026-05-05). The race the prior synchronous flip
        // claimed to fix was illusory: pushes into an open multi-turn stream
        // become the next turn, they're not eaten by the SDK.
        //
        // Mark the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for follow-up
        // pushes. The agent may have responded via MCP (send_message)
        // mid-turn, or the message may not need a response at all — either
        // way the per-turn work for these rows is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      } else if (event.type === 'compacted') {
        // The SDK auto-compacted the conversation. After compaction the
        // model often drops the learned `<message to="…">` wrapping
        // discipline (the destinations are still in the system prompt,
        // but the behavioral pattern is summarized away). Inject a
        // reminder back into the live query so the next turn re-anchors
        // on the destination model. Only do this when there's >1
        // destination — single-destination groups have a fallback that
        // works without wrapping. See qwibitai/nanoclaw#2325.
        const destinations = getAllDestinations();
        if (destinations.length > 1) {
          const names = destinations.map((d) => d.name).join(', ');
          query.push(
            `[system] Context was just compacted. Reminder: you have ${destinations.length} destinations (${names}). ` +
              `Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.`,
          );
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      // Skip internal MCP tool descriptions ("Using <mcp-tool-name>") — these
      // are implementation details not useful to end users. Only surface
      // substantive progress messages (Bash output, search results, etc.).
      if (event.message.startsWith('Using ')) break;
      // Quiet-status mode (set by tasks with quietStatus: true): suppress
      // all streaming status writes. The agent's final chat message — if
      // any — still goes out via dispatchResultText.
      if (routing.quietStatus) break;
      // Emit a kind='status' message so the host can deliver it as a
      // post-then-edit progress line. Host tracks the platform_message_id
      // per session so subsequent progress events edit in place, and the
      // tracking clears when a real chat message lands.
      writeMessageOut({
        id: generateId(),
        kind: 'status',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: event.message }),
      });
      break;
    case 'compacted':
      log(`Compacted: ${event.text}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
export function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Unwrapped-output fallback: if the agent forgot to wrap (a common
  // failure mode after long turns, auto-compaction, or extended thinking),
  // route the cleaned scratchpad to the most-likely-correct destination
  // instead of silently dropping the reply. Two-tier resolution:
  //
  //   1. Origin (preferred): the destination corresponding to the channel
  //      that triggered this turn. Looked up by (channelType, platformId)
  //      from the routing context. Unambiguous regardless of how many
  //      destinations the agent has wired — the user spoke from one place
  //      and expects the reply there. Works for chat, task, and a2a
  //      inbounds (extractRouting falls back to sessionRouting when the
  //      message itself has no platform_id, so routing fields are
  //      populated for every well-formed turn).
  //
  //   2. Single-destination (legacy): if origin can't be resolved
  //      (routing.platformId is null AND there's no sessionRouting fallback)
  //      AND the group has exactly one destination, send there.
  //
  // The original multi-destination concerns (routing drift on null-routed
  // cron tasks, cross-channel thread bleed in agent-shared sessions;
  // commit 9db39b2) don't apply: sendToDestination resolves fresh
  // per-destination routing via resolveDestinationThread, and we route to
  // the origin (not blindly broadcast) so we never bleed into another
  // channel.
  if (sent === 0 && scratchpad) {
    const origin = findByRouting(routing.channelType, routing.platformId);
    if (origin) {
      sendToDestination(origin, scratchpad, routing);
      log(`Origin-fallback: unwrapped text routed to "${origin.name}" (${scratchpad.length} chars)`);
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      log(`Single-destination fallback: bare text routed to "${all[0].name}" (${scratchpad.length} chars)`);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirror of FlagIntent in src/flag-parser.ts. Can't share a module across
// the host/container boundary (separate package trees).
interface FlagIntent {
  stickyModel?: string;
  turnModel?: string;
  clearStickyModel?: boolean;
  stickyEffort?: string;
  turnEffort?: string;
  clearStickyEffort?: boolean;
}

// Precedence: turn override → sticky → host-injected default (NANOCLAW_DEFAULT_EFFORT).
function applyFlagBatch(
  messages: MessageInRow[],
  _routing: RoutingContext,
): { model?: string; effort?: string } {
  let intent: FlagIntent | undefined;
  for (const m of messages) {
    // Tasks carry flagIntent the same way chat messages do — used by scheduled
    // wake tasks (e.g. wiki synthesis) to pin model+effort per fire without a
    // global agent-group config change.
    if (m.kind !== 'chat' && m.kind !== 'chat-sdk' && m.kind !== 'task') continue;
    try {
      const parsed = JSON.parse(m.content) as { flagIntent?: FlagIntent };
      if (parsed.flagIntent) {
        intent = parsed.flagIntent;
        break;
      }
    } catch {
      // malformed content row
    }
  }

  if (intent) {
    if (intent.clearStickyModel) {
      clearStickyModel();
    } else if (intent.stickyModel) {
      setStickyModel(intent.stickyModel);
    }
    if (intent.clearStickyEffort) {
      clearStickyEffort();
    } else if (intent.stickyEffort) {
      setStickyEffort(intent.stickyEffort);
    }
  }

  const model = intent?.turnModel ?? getStickyModel();
  const effort = intent?.turnEffort ?? getStickyEffort() ?? process.env.NANOCLAW_DEFAULT_EFFORT;

  return { model, effort };
}
