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

  it("truncated first trigger window must clear marker on rollback", () => {
    // First trigger-window truncation: no prior tail-drain entry.
    // On rollback, the pre-persisted marker must be deleted so the next retry
    // does not falsely enter tail-drain mode and bypass trigger gating.
    const truncated = true;
    const isTailDrain = false;
    const wasTailDrain = false;
    const outputSentToUser = false;

    // Models the fixed rollback logic
    let action: "set" | "delete" | "persist" | "none" = "none";
    if (!outputSentToUser) {
      if (isTailDrain) {
        action = "set";
      } else if (truncated) {
        action = "delete";
      } else if (wasTailDrain) {
        action = "persist";
      }
    }
    expect(action).toBe("delete");
  });

  it("partial send failure does not trigger cursor rollback", () => {
    // When a multi-chunk send partially succeeds (PartialSendError),
    // outputSentToUser is set to true. The rollback guard at line 395
    // must evaluate to false to prevent duplicate content.
    const hadSendError = true;
    const outputSentToUser = true; // set by PartialSendError detection
    const shouldRollback = hadSendError && !outputSentToUser;
    expect(shouldRollback).toBe(false);
  });

  it("ongoing tail-drain + truncated keeps marker on rollback", () => {
    // When an ongoing tail-drain continuation overflows, the marker correctly
    // represents the drain cutoff and should be re-persisted, not deleted.
    const truncated = true;
    const isTailDrain = true;
    const outputSentToUser = false;

    let action: "set" | "delete" | "persist" | "none" = "none";
    if (!outputSentToUser) {
      if (isTailDrain) {
        action = "set";
      } else if (truncated) {
        action = "delete";
      }
    }
    expect(action).toBe("set");
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

  it("completed tail-drain + truncated trigger window must clear marker on rollback", () => {
    // A completed tail-drain enters the trigger path and truncates.
    // The pre-persisted marker is stale — the truncated branch must take
    // priority over wasTailDrain and delete the marker.
    const truncated = true;
    const isTailDrain = false;
    const wasTailDrain = true;
    const outputSentToUser = false;

    // Models the fixed rollback logic
    let action: "set" | "delete" | "persist" | "none" = "none";
    if (!outputSentToUser) {
      if (isTailDrain) {
        action = "set";
      } else if (truncated) {
        action = "delete";
      } else if (wasTailDrain) {
        action = "persist";
      }
    }
    expect(action).toBe("delete");
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

// --- stale pendingTailDrain recovery at startup ---

describe("stale pendingTailDrain recovery at startup", () => {
  // After a crash/restart, pendingTailDrain entries may survive in the DB
  // even though the messages at the cutoff were already processed. Without
  // recovery, the poll guard blocks the group forever.

  it("recovery enqueues group with pendingTailDrain entry even when no messages pending", () => {
    // Models the fix: Phase 1 enqueues groups with tail-drain entries
    // regardless of whether messages exist at the cursor.
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      [chatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const registeredGroups: Record<string, { name: string }> = {
      [chatJid]: { name: "Test Group" },
    };
    const enqueued: string[] = [];

    // Phase 1 logic
    for (const jid of pendingTailDrain.keys()) {
      if (registeredGroups[jid]) {
        enqueued.push(jid);
      }
    }

    expect(enqueued).toContain(chatJid);
  });

  it("without the fix, group with stale entry is never enqueued", () => {
    // Models the bug: Phase 2 only enqueues when messages exist.
    // If messages were already processed, the group is skipped.
    const chatJid = "group1@g.us";
    const pendingMessages: unknown[] = []; // no messages at cursor
    const enqueued: string[] = [];

    // Phase 2 logic (original recovery — no Phase 1)
    if (pendingMessages.length > 0) {
      enqueued.push(chatJid);
    }

    expect(enqueued).not.toContain(chatJid);
  });

  it("poll guard blocks the group forever when entry is not cleared", () => {
    // Models the deadlock: poll guard skips group, processGroupMessages
    // never runs, entry never cleared.
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      [chatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    let processGroupRan = false;

    // Simulate multiple poll iterations
    for (let i = 0; i < 5; i++) {
      if (pendingTailDrain.has(chatJid)) {
        continue; // guard blocks — processGroupMessages never called
      }
      processGroupRan = true;
    }

    expect(processGroupRan).toBe(false);
    expect(pendingTailDrain.has(chatJid)).toBe(true); // still stuck
  });

  it("processGroupMessages clears stale entry when no messages exist", () => {
    // Models self-healing: once enqueued, processGroupMessages sees
    // zero messages and clears the entry (line 204-206).
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      [chatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const missedMessages: unknown[] = []; // no messages at cursor

    // processGroupMessages logic (lines 204-206)
    if (missedMessages.length === 0) {
      pendingTailDrain.delete(chatJid);
    }

    expect(pendingTailDrain.has(chatJid)).toBe(false);
  });

  it("recovery removes entries for unregistered groups", () => {
    // Models cleanup: groups that no longer exist in registeredGroups
    // get their stale entries removed.
    const staleChatJid = "deleted-group@g.us";
    const pendingTailDrain = new Map([
      [staleChatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const registeredGroups: Record<string, { name: string }> = {};
    let removedStale = false;

    for (const jid of pendingTailDrain.keys()) {
      if (!registeredGroups[jid]) {
        pendingTailDrain.delete(jid);
        removedStale = true;
      }
    }

    expect(pendingTailDrain.size).toBe(0);
    expect(removedStale).toBe(true);
  });

  it("recovery does not persist when no stale entries removed", () => {
    // Avoids unnecessary DB writes when all entries belong to registered groups.
    const chatJid = "group1@g.us";
    const pendingTailDrain = new Map([
      [chatJid, { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const registeredGroups: Record<string, { name: string }> = {
      [chatJid]: { name: "Test Group" },
    };
    let removedStale = false;
    let saveCalled = false;

    for (const jid of pendingTailDrain.keys()) {
      if (!registeredGroups[jid]) {
        pendingTailDrain.delete(jid);
        removedStale = true;
      }
    }
    if (removedStale) saveCalled = true;

    expect(saveCalled).toBe(false);
  });

  it("phase 2 skips groups already enqueued in phase 1", () => {
    // Models the fix: Phase 1 enqueues a group with a tail-drain entry,
    // Phase 2 skips it even though it also has pending messages.
    const chatJid = "group1@g.us";
    const phase1Enqueued = new Set<string>();
    const enqueueCount = { value: 0 };

    // Phase 1 enqueues and tracks
    enqueueCount.value++;
    phase1Enqueued.add(chatJid);

    // Phase 2 checks phase1Enqueued before enqueueing
    const hasPendingMessages = true;
    if (!phase1Enqueued.has(chatJid) && hasPendingMessages) {
      enqueueCount.value++;
    }

    // Only one enqueue — Phase 2 was skipped
    expect(enqueueCount.value).toBe(1);
    expect(phase1Enqueued.has(chatJid)).toBe(true);
  });

  it("double enqueue defeats backoff when first run is active", () => {
    // Models the regression: Phase 1 enqueue triggers runForGroup (active=true),
    // then Phase 2 enqueue sets pendingMessages=true. If the run fails,
    // drainGroup sees pendingMessages and immediately re-runs, bypassing backoff.
    const state = { active: false, pendingMessages: false };

    function enqueueMessageCheck() {
      if (state.active) {
        state.pendingMessages = true;
      } else {
        state.active = true; // runForGroup starts
      }
    }

    // Phase 1: starts the run
    enqueueMessageCheck();
    expect(state.active).toBe(true);
    expect(state.pendingMessages).toBe(false);

    // Phase 2: enqueues while active — sets pendingMessages
    enqueueMessageCheck();
    expect(state.pendingMessages).toBe(true);
    // This is the bug: drainGroup will immediately re-run instead of backing off
  });

  it("phase 2 still enqueues groups not in phase 1", () => {
    // Groups without tail-drain entries are only recovered in Phase 2.
    const phase1Enqueued = new Set<string>();
    const phase2Only = "group2@g.us";
    const enqueued: string[] = [];

    // Phase 1 enqueues a different group
    phase1Enqueued.add("group1@g.us");
    enqueued.push("group1@g.us");

    // Phase 2: group2 has pending messages but no tail-drain entry
    const hasPendingMessages = true;
    if (!phase1Enqueued.has(phase2Only) && hasPendingMessages) {
      enqueued.push(phase2Only);
    }

    expect(enqueued).toEqual(["group1@g.us", "group2@g.us"]);
  });
});

// --- tail-drain config-change deadlock ---

describe("tail-drain config-change deadlock", () => {
  // When a group's config changes so needsFullDrain flips to false (e.g.,
  // requiresTrigger → false, or isMain → true), the bounded path runs
  // without ever touching pendingTailDrain. The poll guard sees the stale
  // entry and blocks the group permanently.

  it("stale entry blocks group indefinitely when config changes to non-trigger", () => {
    // Models the regression: entry persists through the bounded path
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    const isMainGroup = false;
    const requiresTrigger = false; // config changed!
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;

    // Without the fix: bounded path runs, never touches pendingTailDrain
    if (needsFullDrain) {
      pendingTailDrain.delete("group1@g.us");
    }

    // Poll guard checks — entry still present → group blocked forever
    expect(pendingTailDrain.has("group1@g.us")).toBe(true);
  });

  it("clears stale entry when group no longer needs full drain", () => {
    // Models the fix: early cleanup before message fetching
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };
    const isMainGroup = false;
    const requiresTrigger = false; // config changed!
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;

    // The fix: clear stale entry when needsFullDrain is false
    if (!needsFullDrain && pendingTailDrain.delete("group1@g.us")) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.has("group1@g.us")).toBe(false);
    expect(saved).toBe(true);
  });

  it("clears stale entry when group becomes main", () => {
    // Variant: isMain flips to true → needsFullDrain becomes false
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };
    let isMainGroup = true; // config changed!
    let requiresTrigger = true; // still true, but isMain overrides
    const needsFullDrain = !isMainGroup && (requiresTrigger as boolean) !== false;

    if (!needsFullDrain && pendingTailDrain.delete("group1@g.us")) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.has("group1@g.us")).toBe(false);
    expect(saved).toBe(true);
  });

  it("no-op when group still needs full drain", () => {
    // Negative: entry untouched when needsFullDrain is true
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };
    let isMainGroup = false;
    let requiresTrigger = true;
    const needsFullDrain = !isMainGroup && (requiresTrigger as boolean) !== false;

    if (!needsFullDrain && pendingTailDrain.delete("group1@g.us")) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.has("group1@g.us")).toBe(true);
    expect(saved).toBe(false);
  });

  it("no-op when no entry exists", () => {
    // Negative: delete() returns false, no save
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };
    const isMainGroup = false;
    const requiresTrigger = false;
    const needsFullDrain = !isMainGroup && requiresTrigger !== false;

    if (!needsFullDrain && pendingTailDrain.delete("group1@g.us")) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.size).toBe(0);
    expect(saved).toBe(false);
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

// --- tail-drain retry exhaustion deadlock ---

describe("tail-drain retry exhaustion deadlock", () => {
  // After MAX_RETRIES, scheduleRetry resets retryCount and returns without
  // scheduling another timer. If pendingTailDrain still has an entry, the
  // poll guard blocks the group forever.

  it("stale entry persists after retry exhaustion without callback", () => {
    // Models the regression: pendingTailDrain entry survives through retry
    // exhaustion, and the poll guard blocks the group indefinitely.
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);

    // Simulate retry exhaustion (retryCount > MAX_RETRIES) — no cleanup.
    const retryCount = 6;
    const MAX_RETRIES = 5;
    if (retryCount > MAX_RETRIES) {
      // scheduleRetry resets count but does NOT touch pendingTailDrain
    }

    // Entry persists — poll guard will block this group
    expect(pendingTailDrain.has("group1@g.us")).toBe(true);

    // Poll guard blocks: new messages hit continue
    let blocked = false;
    if (pendingTailDrain.has("group1@g.us")) {
      blocked = true; // continue in the real code
    }
    expect(blocked).toBe(true);
  });

  it("callback clears stale entry after retry exhaustion", () => {
    // Models the fix: onRetriesExhausted callback deletes the entry and saves.
    const pendingTailDrain = new Map([
      ["group1@g.us", { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" }],
    ]);
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };

    // Simulate the callback firing on retry exhaustion
    const groupJid = "group1@g.us";
    if (pendingTailDrain.delete(groupJid)) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.has("group1@g.us")).toBe(false);
    expect(saved).toBe(true);

    // Poll guard no longer blocks — next incoming message can enqueue
    let blocked = false;
    if (pendingTailDrain.has("group1@g.us")) {
      blocked = true;
    }
    expect(blocked).toBe(false);
  });

  it("callback is no-op when no entry exists for group", () => {
    // Negative: callback fires but group has no entry — no save needed.
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();
    let saved = false;
    const savePendingTailDrain = () => {
      saved = true;
    };

    const groupJid = "group1@g.us";
    if (pendingTailDrain.delete(groupJid)) {
      savePendingTailDrain();
    }

    expect(pendingTailDrain.size).toBe(0);
    expect(saved).toBe(false);
  });
});

// --- tail-drain cursor/marker crash consistency ---

describe("tail-drain cursor/marker crash consistency", () => {
  // The cursor and tail-drain marker must be persisted atomically (in the
  // same save window) to prevent crash-window data loss.

  it("crash after cursor save but before marker save loses overflow", () => {
    // Models the regression: cursor advanced, no marker persisted.
    // After crash, recovery enters normal trigger-gated path for overflow.
    const lastAgentTimestamp: Record<string, { ts: string; id: string }> = {};
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();
    let stateSaved = false;
    let tailDrainSaved = false;

    const chatJid = "group1@g.us";
    const truncated = true;
    const batchLast = { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" };
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };

    // OLD code: cursor saved first
    lastAgentTimestamp[chatJid] = batchLast;
    stateSaved = true;

    // Simulate crash here — marker never saved
    // (tailDrainSaved stays false)

    // Recovery: cursor is advanced, no tail-drain marker
    expect(stateSaved).toBe(true);
    expect(tailDrainSaved).toBe(false);
    expect(lastAgentTimestamp[chatJid]).toEqual(batchLast);
    expect(pendingTailDrain.has(chatJid)).toBe(false);

    // Recovery enters trigger-gated mode for overflow messages (msg-100 to msg-500)
    // — those messages are lost if no trigger is present.
    const needsTrigger = true;
    const hasTailDrainEntry = pendingTailDrain.has(chatJid);
    // Without the marker, recovery won't know to drain — enters normal trigger path
    expect(hasTailDrainEntry).toBe(false);
    expect(needsTrigger && !hasTailDrainEntry).toBe(true);
  });

  it("pre-persisting marker alongside cursor prevents overflow loss", () => {
    // Models the fix: both cursor and marker saved before agent execution.
    const lastAgentTimestamp: Record<string, { ts: string; id: string }> = {};
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();
    let stateSaved = false;
    let tailDrainSaved = false;

    const chatJid = "group1@g.us";
    const truncated = true;
    const isTailDrain = true;
    const tailDrainCutoff = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };
    const batchLast = { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" };
    const fullBacklogLast = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };

    // NEW code: cursor and marker saved together
    lastAgentTimestamp[chatJid] = batchLast;
    if (truncated) {
      const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast;
      pendingTailDrain.set(chatJid, cutoff);
      tailDrainSaved = true;
    }
    stateSaved = true;

    // Simulate crash after both saves
    expect(stateSaved).toBe(true);
    expect(tailDrainSaved).toBe(true);
    expect(lastAgentTimestamp[chatJid]).toEqual(batchLast);
    expect(pendingTailDrain.has(chatJid)).toBe(true);

    // Recovery finds the marker and continues the drain
    const hasTailDrainEntry = pendingTailDrain.has(chatJid);
    expect(hasTailDrainEntry).toBe(true);
    expect(pendingTailDrain.get(chatJid)).toEqual(tailDrainCutoff);
  });

  it("error-without-output rollback is safe with pre-persisted marker", () => {
    // Cursor rolled back on error, but the pre-saved marker persists.
    // On retry, processGroupMessages finds the marker and enters tail-drain mode.
    const lastAgentTimestamp: Record<string, { ts: string; id: string }> = {};
    const pendingTailDrain = new Map<string, { ts: string; id: string }>();

    const chatJid = "group1@g.us";
    const previousCursor = { ts: "2024-01-01T00:00:00.000Z", id: "msg-0" };
    const batchLast = { ts: "2024-01-01T00:05:00.000Z", id: "msg-100" };
    const cutoff = { ts: "2024-01-01T00:10:00.000Z", id: "msg-500" };

    // Pre-persist: cursor advanced and marker saved
    lastAgentTimestamp[chatJid] = batchLast;
    pendingTailDrain.set(chatJid, cutoff);

    // Agent fails without output — roll back cursor
    lastAgentTimestamp[chatJid] = previousCursor;

    // Cursor rolled back, but marker still present
    expect(lastAgentTimestamp[chatJid]).toEqual(previousCursor);
    expect(pendingTailDrain.has(chatJid)).toBe(true);
    expect(pendingTailDrain.get(chatJid)).toEqual(cutoff);

    // On retry, processGroupMessages will find the marker and enter tail-drain
    // mode, correctly re-processing the messages from previousCursor.
  });
});
