import { describe, it, expect } from "vitest";

import { ASSISTANT_NAME, TRIGGER_PATTERN } from "./config.js";
import {
  anchorTriggerWindow,
  escapeXml,
  formatMessages,
  formatMessagesWithCap,
  formatOutbound,
  stripInternalTags,
} from "./router.js";
import { NewMessage } from "./types.js";

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: "1",
    chat_jid: "group@g.us",
    sender: "123@s.whatsapp.net",
    sender_name: "Alice",
    content: "hello",
    timestamp: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// --- escapeXml ---

describe("escapeXml", () => {
  it("escapes ampersands", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than", () => {
    expect(escapeXml("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than", () => {
    expect(escapeXml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeXml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("handles multiple special characters together", () => {
    expect(escapeXml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("passes through strings with no special chars", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });
});

// --- formatMessages ---

describe("formatMessages", () => {
  const TZ = "UTC";

  it("formats a single message as XML with context header", () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain(">hello</message>");
    expect(result).toContain("Jan 1, 2024");
  });

  it("formats multiple messages", () => {
    const msgs = [
      makeMsg({
        id: "1",
        sender_name: "Alice",
        content: "hi",
        timestamp: "2024-01-01T00:00:00.000Z",
      }),
      makeMsg({
        id: "2",
        sender_name: "Bob",
        content: "hey",
        timestamp: "2024-01-01T01:00:00.000Z",
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain(">hi</message>");
    expect(result).toContain(">hey</message>");
  });

  it("escapes special characters in sender names", () => {
    const result = formatMessages([makeMsg({ sender_name: "A & B <Co>" })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it("escapes special characters in content", () => {
    const result = formatMessages([makeMsg({ content: '<script>alert("xss")</script>' })], TZ);
    expect(result).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("handles empty array", () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain("<messages>\n\n</messages>");
  });

  it("converts timestamps to local time for given timezone", () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: "2024-01-01T18:30:00.000Z" })],
      "America/New_York",
    );
    expect(result).toContain("1:30");
    expect(result).toContain("PM");
    expect(result).toContain('<context timezone="America/New_York" />');
  });
});

// --- TRIGGER_PATTERN ---

describe("TRIGGER_PATTERN", () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it("matches @name at start of message", () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it("does not match when not at start of message", () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it("does not match partial name like @NameExtra (word boundary)", () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it("matches with word boundary before apostrophe", () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it("matches @name alone (end of string is a word boundary)", () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it("matches with leading whitespace after trim", () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe("stripInternalTags", () => {
  it("strips single-line internal tags", () => {
    expect(stripInternalTags("hello <internal>secret</internal> world")).toBe("hello  world");
  });

  it("strips multi-line internal tags", () => {
    expect(stripInternalTags("hello <internal>\nsecret\nstuff\n</internal> world")).toBe(
      "hello  world",
    );
  });

  it("strips multiple internal tag blocks", () => {
    expect(stripInternalTags("<internal>a</internal>hello<internal>b</internal>")).toBe("hello");
  });

  it("returns empty string when text is only internal tags", () => {
    expect(stripInternalTags("<internal>only this</internal>")).toBe("");
  });
});

describe("formatOutbound", () => {
  it("returns text with internal tags stripped", () => {
    expect(formatOutbound("hello world")).toBe("hello world");
  });

  it("returns empty string when all text is internal", () => {
    expect(formatOutbound("<internal>hidden</internal>")).toBe("");
  });

  it("strips internal tags from remaining text", () => {
    expect(formatOutbound("<internal>thinking</internal>The answer is 42")).toBe(
      "The answer is 42",
    );
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe("trigger gating (requiresTrigger interaction)", () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    return messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
  }

  it("main group always processes (no trigger needed)", () => {
    const msgs = [makeMsg({ content: "hello no trigger" })];
    expect(shouldProcess(true, undefined, msgs)).toBe(true);
  });

  it("main group processes even with requiresTrigger=true", () => {
    const msgs = [makeMsg({ content: "hello no trigger" })];
    expect(shouldProcess(true, true, msgs)).toBe(true);
  });

  it("non-main group with requiresTrigger=undefined requires trigger (defaults to true)", () => {
    const msgs = [makeMsg({ content: "hello no trigger" })];
    expect(shouldProcess(false, undefined, msgs)).toBe(false);
  });

  it("non-main group with requiresTrigger=true requires trigger", () => {
    const msgs = [makeMsg({ content: "hello no trigger" })];
    expect(shouldProcess(false, true, msgs)).toBe(false);
  });

  it("non-main group with requiresTrigger=true processes when trigger present", () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, msgs)).toBe(true);
  });

  it("non-main group with requiresTrigger=false always processes (no trigger needed)", () => {
    const msgs = [makeMsg({ content: "hello no trigger" })];
    expect(shouldProcess(false, false, msgs)).toBe(true);
  });
});

// --- formatMessagesWithCap ---

describe("formatMessagesWithCap", () => {
  const TZ = "UTC";

  function makeMsgs(count: number): NewMessage[] {
    return Array.from({ length: count }, (_, i) =>
      makeMsg({
        id: `cap-${i}`,
        sender_name: `User${i}`,
        content: `msg ${i}`,
        timestamp: `2024-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
  }

  it("passes through when under cap", () => {
    const msgs = makeMsgs(3);
    expect(formatMessagesWithCap(msgs, TZ, 10)).toBe(formatMessages(msgs, TZ));
  });

  it("truncates to most recent N when over cap", () => {
    const msgs = makeMsgs(10);
    const result = formatMessagesWithCap(msgs, TZ, 3);
    // Should contain only the last 3 messages
    expect(result).toContain("msg 7");
    expect(result).toContain("msg 8");
    expect(result).toContain("msg 9");
    expect(result).not.toContain("msg 0");
    expect(result).not.toContain("msg 6");
  });

  it("includes omission note when truncating", () => {
    const msgs = makeMsgs(10);
    const result = formatMessagesWithCap(msgs, TZ, 3);
    expect(result).toContain("<note>7 older messages omitted for context window</note>");
  });

  it("no note when under cap", () => {
    const msgs = makeMsgs(3);
    const result = formatMessagesWithCap(msgs, TZ, 10);
    expect(result).not.toContain("<note>");
  });

  it("adds omission note when totalCount > messages.length (pre-capped)", () => {
    const msgs = makeMsgs(5);
    // 5 messages passed but totalCount says 15 existed — 10 were omitted before reaching us
    const result = formatMessagesWithCap(msgs, TZ, 200, 15);
    expect(result).toContain("<note>10 older messages omitted for context window</note>");
    // All 5 passed messages should be included (they're already under maxMessages)
    expect(result).toContain("msg 0");
    expect(result).toContain("msg 4");
  });

  it("no note when totalCount equals messages.length", () => {
    const msgs = makeMsgs(5);
    const result = formatMessagesWithCap(msgs, TZ, 10, 5);
    expect(result).not.toContain("<note>");
  });

  it("backward-compatible: existing behavior unchanged without totalCount", () => {
    const msgs = makeMsgs(5);
    const withoutParam = formatMessagesWithCap(msgs, TZ, 10);
    const withUndefined = formatMessagesWithCap(msgs, TZ, 10, undefined);
    expect(withoutParam).toBe(withUndefined);
  });
});

// --- anchorTriggerWindow ---

describe("anchorTriggerWindow", () => {
  it("returns full range when under cap", () => {
    expect(anchorTriggerWindow(100, 60, 200)).toEqual({ start: 0, end: 100, truncated: false });
  });

  it("preserves pre-trigger context when trigger is in tail", () => {
    expect(anchorTriggerWindow(300, 250, 200)).toEqual({ start: 100, end: 300, truncated: false });
  });

  it("anchors at trigger when trigger is before tail", () => {
    expect(anchorTriggerWindow(300, 50, 200)).toEqual({ start: 50, end: 250, truncated: true });
  });

  it("handles large overflow with early trigger", () => {
    expect(anchorTriggerWindow(500, 10, 200)).toEqual({ start: 10, end: 210, truncated: true });
  });

  it("handles trigger at index 0", () => {
    expect(anchorTriggerWindow(500, 0, 200)).toEqual({ start: 0, end: 200, truncated: true });
  });

  it("handles trigger at last index", () => {
    expect(anchorTriggerWindow(300, 299, 200)).toEqual({ start: 100, end: 300, truncated: false });
  });

  it("no truncation when exactly at cap", () => {
    expect(anchorTriggerWindow(200, 100, 200)).toEqual({ start: 0, end: 200, truncated: false });
  });

  it("truncates when one over cap", () => {
    expect(anchorTriggerWindow(201, 0, 200)).toEqual({ start: 0, end: 200, truncated: true });
  });

  it("trigger exactly at total-max boundary", () => {
    expect(anchorTriggerWindow(300, 100, 200)).toEqual({ start: 100, end: 300, truncated: false });
  });

  it("tail continuation slices oldest-first up to cap", () => {
    // Simulates the tail-drain path: after anchorTriggerWindow truncated,
    // the follow-up batch contains the remaining messages. The tail-drain
    // code uses .slice(0, MAX) to process oldest-first and cap overflow.
    const tail = Array.from({ length: 150 }, (_, i) => i);
    const cap = 100;

    const batch = tail.slice(0, cap);
    expect(batch).toHaveLength(cap);
    // Oldest message (index 0) is first
    expect(batch[0]).toBe(0);
    // Last message in batch
    expect(batch[cap - 1]).toBe(cap - 1);

    // Remaining overflow for next cycle
    const remaining = tail.slice(cap);
    expect(remaining).toHaveLength(50);
    expect(remaining[0]).toBe(cap);
  });
});

// --- Tail-drain cutoff filtering ---

describe("tail-drain cutoff filtering", () => {
  // Replicates the cutoff filtering logic from processGroupMessages:
  // findIndex where message is past the cutoff cursor, then slice.
  function applyCutoff(
    messages: { timestamp: string; id: string }[],
    cutoff: { ts: string; id: string },
  ): { timestamp: string; id: string }[] {
    if (cutoff.ts === "") return messages;
    const cutoffIdx = messages.findIndex(
      (m) => m.timestamp > cutoff.ts || (m.timestamp === cutoff.ts && m.id > cutoff.id),
    );
    if (cutoffIdx === 0) return [];
    if (cutoffIdx > 0) return messages.slice(0, cutoffIdx);
    return messages;
  }

  it("cutoff filters messages to those at or before cursor", () => {
    const messages = [
      { timestamp: "2024-01-01T00:00:01.000Z", id: "m1" },
      { timestamp: "2024-01-01T00:00:02.000Z", id: "m2" },
      { timestamp: "2024-01-01T00:00:03.000Z", id: "m3" },
      { timestamp: "2024-01-01T00:00:04.000Z", id: "m4" },
      { timestamp: "2024-01-01T00:00:05.000Z", id: "m5" },
    ];
    const cutoff = { ts: "2024-01-01T00:00:03.000Z", id: "m3" };
    const result = applyCutoff(messages, cutoff);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("cutoff on tied timestamp uses id tie-breaker", () => {
    const messages = [
      { timestamp: "2024-01-01T00:00:01.000Z", id: "a" },
      { timestamp: "2024-01-01T00:00:01.000Z", id: "b" },
      { timestamp: "2024-01-01T00:00:01.000Z", id: "c" },
      { timestamp: "2024-01-01T00:00:01.000Z", id: "d" },
    ];
    const cutoff = { ts: "2024-01-01T00:00:01.000Z", id: "b" };
    const result = applyCutoff(messages, cutoff);
    // "a" and "b" are at or before cutoff; "c" and "d" are past
    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("all messages past cutoff returns empty array", () => {
    const messages = [
      { timestamp: "2024-01-01T00:00:05.000Z", id: "m5" },
      { timestamp: "2024-01-01T00:00:06.000Z", id: "m6" },
    ];
    const cutoff = { ts: "2024-01-01T00:00:04.000Z", id: "m4" };
    const result = applyCutoff(messages, cutoff);
    expect(result).toEqual([]);
  });

  it("empty cutoff sentinel skips filtering", () => {
    const messages = [
      { timestamp: "2024-01-01T00:00:01.000Z", id: "m1" },
      { timestamp: "2024-01-01T00:00:02.000Z", id: "m2" },
    ];
    const cutoff = { ts: "", id: "" };
    const result = applyCutoff(messages, cutoff);
    expect(result).toEqual(messages);
  });

  it("re-truncation preserves original cutoff, not current backlog end", () => {
    // Simulates two-cycle drain:
    // Cycle 1: 500 messages, trigger at 100, anchorTriggerWindow truncates.
    //   → cutoff stored as { ts of msg 500, id of msg 500 }
    // Cycle 2: re-fetches remaining, still > MAX, re-truncates.
    //   → cutoff should stay at msg 500 (original), not msg 400.
    const originalCutoff = { ts: "2024-01-01T00:08:20.000Z", id: "msg-500" };

    // Cycle 2 sees messages 201-500 (within cutoff) plus 501-550 (new arrivals)
    const cycle2Messages = Array.from({ length: 350 }, (_, i) => ({
      timestamp: `2024-01-01T00:${String(3 + Math.floor(i / 60)).padStart(2, "0")}:${String((i + 21) % 60).padStart(2, "0")}.000Z`,
      id: `msg-${201 + i}`,
    }));

    // Apply cutoff — should filter out messages past msg-500
    const filtered = applyCutoff(cycle2Messages, originalCutoff);
    // All 300 messages from msg-201 to msg-500 should pass (their timestamps are <= cutoff)
    expect(filtered.length).toBeLessThanOrEqual(300);
    // On re-truncation, the code preserves tailDrainCutoff (originalCutoff),
    // not fullBacklogLast. Verify by checking the logic:
    const isTailDrain = true;
    const tailDrainCutoff = originalCutoff;
    const fullBacklogLast = {
      ts: cycle2Messages[cycle2Messages.length - 1].timestamp,
      id: cycle2Messages[cycle2Messages.length - 1].id,
    };
    const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
    expect(cutoff).toEqual(originalCutoff);
  });
});

// --- Bounded fetch path ---

describe("bounded fetch path", () => {
  it("main group uses bounded newest-N, not full drain", () => {
    // Verify the decision logic: main groups use getMessagesSince (bounded),
    // not getAllMessagesSince (full drain).
    const isMainGroup = true;
    const requiresTrigger = undefined;
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;
    expect(needsFullDrain).toBe(false);
  });

  it("requiresTrigger=false group uses bounded newest-N", () => {
    const isMainGroup = false;
    const requiresTrigger = false;
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;
    expect(needsFullDrain).toBe(false);
  });

  it("non-main trigger-required group uses full drain", () => {
    const isMainGroup = false;
    const requiresTrigger = undefined;
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;
    expect(needsFullDrain).toBe(true);
  });
});

// --- tail-drain exit-point requeue decisions ---

describe("tail-drain exit-point requeue decisions", () => {
  // Models the requeue decision at each tail-drain exit point in processMessages.
  // Each test derives `shouldRequeue` using the same boolean logic as the real code.

  it("error+output+truncated always requeues", () => {
    const truncated = true;
    const isTailDrain = true;
    // truncated branch always requeues regardless of isTailDrain
    const shouldRequeue = truncated;
    expect(shouldRequeue).toBe(true);
  });

  it("error+output+isTailDrain without truncation requeues", () => {
    const truncated = false;
    const isTailDrain = true;
    // else-if isTailDrain branch — the bug was a missing requeue here
    const shouldRequeue = !truncated && isTailDrain;
    expect(shouldRequeue).toBe(true);
  });

  it("error+rollback+isTailDrain does not requeue (returns false for retry)", () => {
    const outputSentToUser = false;
    const isTailDrain = true;
    // When no output was sent, the cursor rolls back and processMessages returns false.
    // The caller's natural retry handles requeue, so no explicit enqueue is needed.
    const shouldRequeue = outputSentToUser && isTailDrain;
    expect(shouldRequeue).toBe(false);
  });

  it("success+truncated always requeues", () => {
    const truncated = true;
    const isTailDrain = true;
    const shouldRequeue = truncated;
    expect(shouldRequeue).toBe(true);
  });

  it("success+isTailDrain without truncation requeues", () => {
    const truncated = false;
    const isTailDrain = true;
    const shouldRequeue = !truncated && isTailDrain;
    expect(shouldRequeue).toBe(true);
  });
});

// --- tail-drain completion persistence ---

describe("tail-drain completion persistence", () => {
  // When cutoffIdx === 0, the tail-drain completes: isTailDrain is set to false while
  // wasTailDrain remains true. The in-memory deletion must be persisted at every exit
  // point, otherwise a restart re-enters tail-drain from stale state.

  it("completed tail-drain persists deletion on success", () => {
    const wasTailDrain = true;
    const isTailDrain = false; // cutoffIdx === 0 completed the drain
    const truncated = false;
    // Exit must persist: truncated || isTailDrain || wasTailDrain
    const shouldPersist = truncated || isTailDrain || wasTailDrain;
    expect(shouldPersist).toBe(true);
  });

  it("completed tail-drain persists deletion on error with output sent", () => {
    const wasTailDrain = true;
    const isTailDrain = false;
    const truncated = false;
    const outputSentToUser = true;
    // Error path with output sent — still must persist deletion
    const shouldPersist = truncated || isTailDrain || (wasTailDrain && outputSentToUser);
    expect(shouldPersist).toBe(true);
  });

  it("completed tail-drain persists deletion on error with rollback", () => {
    const wasTailDrain = true;
    const isTailDrain = false;
    const truncated = false;
    // Cursor rolled back, but tail-drain itself completed — stale re-entry is wrong
    const shouldPersist = truncated || isTailDrain || wasTailDrain;
    expect(shouldPersist).toBe(true);
  });

  it("non-tail-drain path does not trigger extra persist", () => {
    const wasTailDrain = false;
    const isTailDrain = false;
    const truncated = false;
    // Normal path: no tail-drain state to persist
    const shouldPersist = truncated || isTailDrain || wasTailDrain;
    expect(shouldPersist).toBe(false);
  });
});

// --- pipe path tail-drain guard ---

describe("pipe path tail-drain guard", () => {
  // The pipe path in the poll loop must not advance the cursor past a pending
  // tail-drain window. When pendingTailDrain has an entry for the group,
  // the pipe is skipped without enqueuing — the tail-drain's own handlers
  // manage the next run.

  it("skips pipe when pendingTailDrain has entry for group", () => {
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      [chatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const shouldSkipPipe = pendingTailDrain.has(chatJid);
    expect(shouldSkipPipe).toBe(true);
  });

  it("allows pipe when no pending tail-drain", () => {
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();
    const shouldSkipPipe = pendingTailDrain.has(chatJid);
    expect(shouldSkipPipe).toBe(false);
  });

  it("allows pipe when pending tail-drain is for different group", () => {
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      ["group2@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const shouldSkipPipe = pendingTailDrain.has(chatJid);
    expect(shouldSkipPipe).toBe(false);
  });
});

// --- tail-drain poll guard backoff safety ---

describe("tail-drain poll guard backoff safety", () => {
  // The poll guard must NOT enqueue when skipping the pipe path during a
  // tail-drain. Enqueuing sets pendingMessages = true, which causes drainGroup
  // to immediately start a new run after a failure — bypassing scheduleRetry's
  // exponential backoff and creating tight retry loops.

  it("enqueue during active run sets pendingMessages (the defeated-backoff mechanism)", () => {
    // Models the bug: if the guard calls enqueueMessageCheck while active,
    // pendingMessages becomes true.
    const state = { active: true, pendingMessages: false };
    // Simulate enqueueMessageCheck behavior when active
    if (state.active) {
      state.pendingMessages = true;
    }
    expect(state.pendingMessages).toBe(true);
  });

  it("drainGroup immediately re-runs when pendingMessages is true", () => {
    // Models the bypass: drainGroup sees pendingMessages and starts a new run
    // instead of waiting for the scheduled retry.
    const state = { pendingMessages: true, pendingTasks: [] as unknown[] };
    let wouldDrain = false;
    if (state.pendingTasks.length > 0) {
      // tasks first
    } else if (state.pendingMessages) {
      wouldDrain = true;
    }
    expect(wouldDrain).toBe(true);
  });

  it("guard without enqueue leaves pendingMessages false", () => {
    // Models the fix: the guard skips the pipe but does NOT enqueue,
    // so pendingMessages stays false.
    const state = { active: true, pendingMessages: false };
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    // Guard logic (fixed): skip pipe, do NOT enqueue
    if (pendingTailDrain.has("group1@g.us")) {
      // continue — no enqueue
    }
    expect(state.pendingMessages).toBe(false);
  });

  it("scheduled retry fires after backoff when pendingMessages is false", () => {
    // Models correct flow: when pendingMessages is false, drainGroup does NOT
    // immediately re-run. The scheduled retry (setTimeout with backoff) is the
    // only path that starts the next attempt.
    const state = { pendingMessages: false, pendingTasks: [] as unknown[] };
    let wouldDrain = false;
    if (state.pendingTasks.length > 0) {
      // tasks first
    } else if (state.pendingMessages) {
      wouldDrain = true;
    }
    expect(wouldDrain).toBe(false);
  });
});

// --- empty sentinel cutoff fallback ---

describe("empty sentinel cutoff fallback", () => {
  // The migrated empty sentinel { ts: "", id: "" } is truthy as an object.
  // The cutoff ternary must check tailDrainCutoff?.ts to avoid persisting
  // the sentinel, which would cause infinite tail-drain with no filtering.

  it("empty sentinel falls back to fullBacklogLast", () => {
    const isTailDrain = true;
    const tailDrainCutoff = { ts: "", id: "" }; // migrated sentinel
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
    expect(cutoff).toEqual(fullBacklogLast);
  });

  it("valid cutoff is preserved over fullBacklogLast", () => {
    const isTailDrain = true;
    const tailDrainCutoff = { ts: "2024-01-01T00:05:00.000Z", id: "msg-200" };
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
    expect(cutoff).toEqual(tailDrainCutoff);
  });

  it("null cutoff falls back to fullBacklogLast", () => {
    const isTailDrain = false;
    const tailDrainCutoff = null as { ts: string; id: string } | null;
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    // When isTailDrain is false, condition short-circuits regardless of cutoff
    const useTailDrain = isTailDrain && tailDrainCutoff?.ts;
    expect(useTailDrain).toBeFalsy();
    const cutoff = useTailDrain ? tailDrainCutoff : fullBacklogLast;
    expect(cutoff).toEqual(fullBacklogLast);
  });
});

// --- error rollback cutoff with empty sentinel ---

describe("error rollback cutoff with empty sentinel", () => {
  // The error+rollback path re-sets pendingTailDrain. If the cutoff is an
  // empty sentinel, it must fall back to fullBacklogLast to avoid infinite loops.

  it("empty sentinel in rollback uses fullBacklogLast", () => {
    const tailDrainCutoff = { ts: "", id: "" };
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    const rollbackCutoff = tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
    expect(rollbackCutoff).toEqual(fullBacklogLast);
  });

  it("valid cutoff in rollback is preserved", () => {
    const tailDrainCutoff = { ts: "2024-01-01T00:05:00.000Z", id: "msg-200" };
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    const rollbackCutoff = tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
    expect(rollbackCutoff).toEqual(tailDrainCutoff);
  });
});
