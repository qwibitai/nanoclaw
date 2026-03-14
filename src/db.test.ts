import { describe, it, expect, beforeEach } from "vitest";

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllMessagesSince,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from "./db.js";

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe("storeMessage", () => {
  it("stores a message and retrieves it", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "msg-1",
      chat_jid: "group@g.us",
      sender: "123@s.whatsapp.net",
      sender_name: "Alice",
      content: "hello world",
      timestamp: "2024-01-01T00:00:01.000Z",
    });

    const messages = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy");
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("msg-1");
    expect(messages[0].sender).toBe("123@s.whatsapp.net");
    expect(messages[0].sender_name).toBe("Alice");
    expect(messages[0].content).toBe("hello world");
  });

  it("filters out empty content", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "msg-2",
      chat_jid: "group@g.us",
      sender: "111@s.whatsapp.net",
      sender_name: "Dave",
      content: "",
      timestamp: "2024-01-01T00:00:04.000Z",
    });

    const messages = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy");
    expect(messages).toHaveLength(0);
  });

  it("stores is_from_me flag", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "msg-3",
      chat_jid: "group@g.us",
      sender: "me@s.whatsapp.net",
      sender_name: "Me",
      content: "my message",
      timestamp: "2024-01-01T00:00:05.000Z",
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy");
    expect(messages).toHaveLength(1);
  });

  it("upserts on duplicate id+chat_jid", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "msg-dup",
      chat_jid: "group@g.us",
      sender: "123@s.whatsapp.net",
      sender_name: "Alice",
      content: "original",
      timestamp: "2024-01-01T00:00:01.000Z",
    });

    store({
      id: "msg-dup",
      chat_jid: "group@g.us",
      sender: "123@s.whatsapp.net",
      sender_name: "Alice",
      content: "updated",
      timestamp: "2024-01-01T00:00:01.000Z",
    });

    const messages = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("updated");
  });
});

// --- getMessagesSince ---

describe("getMessagesSince", () => {
  beforeEach(() => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "m1",
      chat_jid: "group@g.us",
      sender: "Alice@s.whatsapp.net",
      sender_name: "Alice",
      content: "first",
      timestamp: "2024-01-01T00:00:01.000Z",
    });
    store({
      id: "m2",
      chat_jid: "group@g.us",
      sender: "Bob@s.whatsapp.net",
      sender_name: "Bob",
      content: "second",
      timestamp: "2024-01-01T00:00:02.000Z",
    });
    storeMessage({
      id: "m3",
      chat_jid: "group@g.us",
      sender: "Bot@s.whatsapp.net",
      sender_name: "Bot",
      content: "bot reply",
      timestamp: "2024-01-01T00:00:03.000Z",
      is_bot_message: true,
    });
    store({
      id: "m4",
      chat_jid: "group@g.us",
      sender: "Carol@s.whatsapp.net",
      sender_name: "Carol",
      content: "third",
      timestamp: "2024-01-01T00:00:04.000Z",
    });
  });

  it("returns messages after the given timestamp", () => {
    const msgs = getMessagesSince("group@g.us", "2024-01-01T00:00:02.000Z", "Andy");
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("third");
  });

  it("excludes bot messages via is_bot_message flag", () => {
    const msgs = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy");
    const botMsgs = msgs.filter((m) => m.content === "bot reply");
    expect(botMsgs).toHaveLength(0);
  });

  it("returns all non-bot messages when sinceTimestamp is empty", () => {
    const msgs = getMessagesSince("group@g.us", "", "Andy");
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it("filters pre-migration bot messages via content prefix backstop", () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: "m5",
      chat_jid: "group@g.us",
      sender: "Bot@s.whatsapp.net",
      sender_name: "Bot",
      content: "Andy: old bot reply",
      timestamp: "2024-01-01T00:00:05.000Z",
    });
    const msgs = getMessagesSince("group@g.us", "2024-01-01T00:00:04.000Z", "Andy");
    expect(msgs).toHaveLength(0);
  });

  it("sinceId skips same-timestamp messages at or before cursor id", () => {
    // Use a separate chat_jid to avoid collisions with beforeEach fixtures
    const jid = "cursor-test@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    const T2 = "2024-01-01T00:00:02.000Z";
    store({
      id: "a",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-a",
      timestamp: T,
    });
    store({
      id: "b",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-b",
      timestamp: T,
    });
    store({
      id: "c",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-c",
      timestamp: T,
    });
    store({
      id: "d",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-d",
      timestamp: T2,
    });

    const msgs = getMessagesSince(jid, T, "Andy", 200, "b");
    expect(msgs.map((m) => m.id)).toEqual(["c", "d"]);
  });

  it("sinceId=undefined preserves backward-compatible timestamp-only behavior", () => {
    const jid = "cursor-compat@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    const T2 = "2024-01-01T00:00:02.000Z";
    store({
      id: "a2",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-a",
      timestamp: T,
    });
    store({
      id: "b2",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-b",
      timestamp: T,
    });
    store({
      id: "c2",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-c",
      timestamp: T,
    });
    store({
      id: "d2",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-d",
      timestamp: T2,
    });

    // No sinceId → timestamp-only → only messages strictly after T
    const msgs = getMessagesSince(jid, T, "Andy");
    expect(msgs.map((m) => m.id)).toEqual(["d2"]);
  });

  it("recovery probe with limit=1 and sinceId finds tied-timestamp messages", () => {
    const jid = "cursor-recovery@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    store({
      id: "ra",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-a",
      timestamp: T,
    });
    store({
      id: "rb",
      chat_jid: jid,
      sender: "u@s",
      sender_name: "U",
      content: "msg-b",
      timestamp: T,
    });

    // With sinceId: finds "rb" (the bug fix)
    const withId = getMessagesSince(jid, T, "Andy", 1, "ra");
    expect(withId).toHaveLength(1);
    expect(withId[0].id).toBe("rb");

    // Without sinceId: misses it (the bug)
    const withoutId = getMessagesSince(jid, T, "Andy", 1);
    expect(withoutId).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe("getNewMessages", () => {
  beforeEach(() => {
    storeChatMetadata("group1@g.us", "2024-01-01T00:00:00.000Z");
    storeChatMetadata("group2@g.us", "2024-01-01T00:00:00.000Z");

    store({
      id: "a1",
      chat_jid: "group1@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "g1 msg1",
      timestamp: "2024-01-01T00:00:01.000Z",
    });
    store({
      id: "a2",
      chat_jid: "group2@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "g2 msg1",
      timestamp: "2024-01-01T00:00:02.000Z",
    });
    storeMessage({
      id: "a3",
      chat_jid: "group1@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "bot reply",
      timestamp: "2024-01-01T00:00:03.000Z",
      is_bot_message: true,
    });
    store({
      id: "a4",
      chat_jid: "group1@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "g1 msg2",
      timestamp: "2024-01-01T00:00:04.000Z",
    });
  });

  it("returns new messages across multiple groups", () => {
    const { messages, newTimestamp } = getNewMessages(
      ["group1@g.us", "group2@g.us"],
      "2024-01-01T00:00:00.000Z",
      "Andy",
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe("2024-01-01T00:00:04.000Z");
  });

  it("filters by timestamp", () => {
    const { messages } = getNewMessages(
      ["group1@g.us", "group2@g.us"],
      "2024-01-01T00:00:02.000Z",
      "Andy",
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("g1 msg2");
  });

  it("returns empty for no registered groups", () => {
    const { messages, newTimestamp } = getNewMessages([], "", "Andy");
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe("");
  });
});

// --- storeChatMetadata ---

describe("storeChatMetadata", () => {
  it("stores chat with JID as default name", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe("group@g.us");
    expect(chats[0].name).toBe("group@g.us");
  });

  it("stores chat with explicit name", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z", "My Group");
    const chats = getAllChats();
    expect(chats[0].name).toBe("My Group");
  });

  it("updates name on subsequent call with name", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");
    storeChatMetadata("group@g.us", "2024-01-01T00:00:01.000Z", "Updated Name");
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe("Updated Name");
  });

  it("preserves newer timestamp on conflict", () => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:05.000Z");
    storeChatMetadata("group@g.us", "2024-01-01T00:00:01.000Z");
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe("2024-01-01T00:00:05.000Z");
  });
});

// --- Task CRUD ---

describe("task CRUD", () => {
  it("creates and retrieves a task", () => {
    createTask({
      id: "task-1",
      group_folder: "main",
      chat_jid: "group@g.us",
      prompt: "do something",
      schedule_type: "once",
      schedule_value: "2024-06-01T00:00:00.000Z",
      context_mode: "isolated",
      next_run: "2024-06-01T00:00:00.000Z",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const task = getTaskById("task-1");
    expect(task).toBeDefined();
    expect(task!.prompt).toBe("do something");
    expect(task!.status).toBe("active");
  });

  it("updates task status", () => {
    createTask({
      id: "task-2",
      group_folder: "main",
      chat_jid: "group@g.us",
      prompt: "test",
      schedule_type: "once",
      schedule_value: "2024-06-01T00:00:00.000Z",
      context_mode: "isolated",
      next_run: null,
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    updateTask("task-2", { status: "paused" });
    expect(getTaskById("task-2")!.status).toBe("paused");
  });

  it("deletes a task and its run logs", () => {
    createTask({
      id: "task-3",
      group_folder: "main",
      chat_jid: "group@g.us",
      prompt: "delete me",
      schedule_type: "once",
      schedule_value: "2024-06-01T00:00:00.000Z",
      context_mode: "isolated",
      next_run: null,
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    deleteTask("task-3");
    expect(getTaskById("task-3")).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe("message query LIMIT", () => {
  beforeEach(() => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: "group@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
  });

  it("getNewMessages caps to limit and returns most recent in chronological order", () => {
    const { messages, newTimestamp } = getNewMessages(
      ["group@g.us"],
      "2024-01-01T00:00:00.000Z",
      "Andy",
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("message 8");
    expect(messages[2].content).toBe("message 10");
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe("2024-01-01T00:00:10.000Z");
  });

  it("getMessagesSince caps to limit and returns most recent in chronological order", () => {
    const messages = getMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy", 3);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("message 8");
    expect(messages[2].content).toBe("message 10");
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it("returns all messages when count is under the limit", () => {
    const { messages } = getNewMessages(["group@g.us"], "2024-01-01T00:00:00.000Z", "Andy", 50);
    expect(messages).toHaveLength(10);
  });
});

// --- getAllMessagesSince (drain loop) ---

describe("getAllMessagesSince", () => {
  beforeEach(() => {
    storeChatMetadata("group@g.us", "2024-01-01T00:00:00.000Z");

    for (let i = 1; i <= 10; i++) {
      store({
        id: `drain-${i}`,
        chat_jid: "group@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
  });

  it("drains all messages across multiple batches", () => {
    const msgs = getAllMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy", 3);
    expect(msgs).toHaveLength(10);
    expect(msgs[0].content).toBe("message 1");
    expect(msgs[9].content).toBe("message 10");
  });

  it("returns empty array when no messages exist", () => {
    const msgs = getAllMessagesSince("group@g.us", "2024-01-01T01:00:00.000Z", "Andy", 3);
    expect(msgs).toHaveLength(0);
  });

  it("handles count exactly equal to batchSize", () => {
    // 6 messages (5 through 10) with batchSize 3 → two full batches
    const msgs = getAllMessagesSince("group@g.us", "2024-01-01T00:00:04.000Z", "Andy", 3);
    expect(msgs).toHaveLength(6);
    expect(msgs[0].content).toBe("message 5");
    expect(msgs[5].content).toBe("message 10");
  });

  it("single batch when under batchSize", () => {
    const msgs = getAllMessagesSince("group@g.us", "2024-01-01T00:00:08.000Z", "Andy", 200);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("message 9");
    expect(msgs[1].content).toBe("message 10");
  });

  it("preserves chronological order across batches", () => {
    const msgs = getAllMessagesSince("group@g.us", "2024-01-01T00:00:00.000Z", "Andy", 3);
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp >= msgs[i - 1].timestamp).toBe(true);
    }
  });

  it("does not skip messages when all share the same timestamp", () => {
    storeChatMetadata("dup@g.us", "2024-01-01T00:00:00.000Z");
    for (let i = 1; i <= 5; i++) {
      store({
        id: `dup-${i}`,
        chat_jid: "dup@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `dup message ${i}`,
        timestamp: "2024-01-01T00:00:01.000Z",
      });
    }
    const msgs = getAllMessagesSince("dup@g.us", "2024-01-01T00:00:00.000Z", "Andy", 3);
    expect(msgs).toHaveLength(5);
    const ids = msgs.map((m) => m.id);
    for (let i = 1; i <= 5; i++) {
      expect(ids).toContain(`dup-${i}`);
    }
  });

  it("handles mixed unique and duplicate timestamps across batches", () => {
    storeChatMetadata("mix@g.us", "2024-01-01T00:00:00.000Z");
    const rows = [
      { id: "mix-a1", ts: "2024-01-01T00:00:01.000Z" },
      { id: "mix-a2", ts: "2024-01-01T00:00:01.000Z" },
      { id: "mix-b1", ts: "2024-01-01T00:00:02.000Z" },
      { id: "mix-b2", ts: "2024-01-01T00:00:02.000Z" },
      { id: "mix-b3", ts: "2024-01-01T00:00:02.000Z" },
      { id: "mix-c1", ts: "2024-01-01T00:00:03.000Z" },
    ];
    for (const r of rows) {
      store({
        id: r.id,
        chat_jid: "mix@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `content ${r.id}`,
        timestamp: r.ts,
      });
    }
    const msgs = getAllMessagesSince("mix@g.us", "2024-01-01T00:00:00.000Z", "Andy", 2);
    expect(msgs).toHaveLength(6);
    const ids = msgs.map((m) => m.id);
    for (const r of rows) {
      expect(ids).toContain(r.id);
    }
  });

  it("sinceId excludes same-timestamp messages at or before the cursor id", () => {
    storeChatMetadata("sid@g.us", "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    for (const id of ["a", "b", "c"]) {
      store({
        id,
        chat_jid: "sid@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `msg ${id}`,
        timestamp: T,
      });
    }
    store({
      id: "d",
      chat_jid: "sid@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "msg d",
      timestamp: "2024-01-01T00:00:02.000Z",
    });
    const msgs = getAllMessagesSince("sid@g.us", T, "Andy", 200, "b");
    const ids = msgs.map((m) => m.id);
    expect(ids).toEqual(["c", "d"]);
  });

  it("sinceId=undefined preserves backward-compatible behavior", () => {
    storeChatMetadata("compat@g.us", "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    for (const id of ["a", "b", "c"]) {
      store({
        id,
        chat_jid: "compat@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `msg ${id}`,
        timestamp: T,
      });
    }
    store({
      id: "d",
      chat_jid: "compat@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "msg d",
      timestamp: "2024-01-01T00:00:02.000Z",
    });
    // Without sinceId, only messages with timestamp > T are returned
    const msgs = getAllMessagesSince("compat@g.us", T, "Andy");
    const ids = msgs.map((m) => m.id);
    expect(ids).toEqual(["d"]);
  });

  it("composite cursor round-trip simulating truncation boundary", () => {
    storeChatMetadata("trunc@g.us", "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:05.000Z";
    // 10 messages: 1-5 have unique timestamps, 6-8 share timestamp T, 9-10 are later
    const rows = [
      { id: "t01", ts: "2024-01-01T00:00:01.000Z" },
      { id: "t02", ts: "2024-01-01T00:00:02.000Z" },
      { id: "t03", ts: "2024-01-01T00:00:03.000Z" },
      { id: "t04", ts: "2024-01-01T00:00:04.000Z" },
      { id: "t05", ts: T },
      { id: "t06", ts: T },
      { id: "t07", ts: T },
      { id: "t08", ts: "2024-01-01T00:00:06.000Z" },
      { id: "t09", ts: "2024-01-01T00:00:07.000Z" },
      { id: "t10", ts: "2024-01-01T00:00:08.000Z" },
    ];
    for (const r of rows) {
      store({
        id: r.id,
        chat_jid: "trunc@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `content ${r.id}`,
        timestamp: r.ts,
      });
    }

    // First call: get all 10
    const first = getAllMessagesSince("trunc@g.us", "", "Andy");
    expect(first).toHaveLength(10);

    // Simulate processing first 7 messages — cursor lands on t07 (shares timestamp T)
    const processed = first.slice(0, 7);
    const cursorMsg = processed[processed.length - 1];
    expect(cursorMsg.id).toBe("t07");

    // Second call with composite cursor — should return exactly the remaining 3
    const second = getAllMessagesSince(
      "trunc@g.us",
      cursorMsg.timestamp,
      "Andy",
      200,
      cursorMsg.id,
    );
    const secondIds = second.map((m) => m.id);
    expect(secondIds).toEqual(["t08", "t09", "t10"]);
  });

  it("maxRows caps total returned rows", () => {
    const msgs = getAllMessagesSince(
      "group@g.us",
      "2024-01-01T00:00:00.000Z",
      "Andy",
      3,
      undefined,
      5,
    );
    expect(msgs).toHaveLength(5);
    expect(msgs[0].content).toBe("message 1");
    expect(msgs[4].content).toBe("message 5");
  });

  it("maxRows less than batchSize uses single bounded query", () => {
    const msgs = getAllMessagesSince(
      "group@g.us",
      "2024-01-01T00:00:00.000Z",
      "Andy",
      200,
      undefined,
      4,
    );
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe("message 1");
    expect(msgs[3].content).toBe("message 4");
  });

  it("maxRows equal to total rows returns all", () => {
    const msgs = getAllMessagesSince(
      "group@g.us",
      "2024-01-01T00:00:00.000Z",
      "Andy",
      3,
      undefined,
      10,
    );
    expect(msgs).toHaveLength(10);
  });

  it("maxRows with composite cursor", () => {
    storeChatMetadata("maxcur@g.us", "2024-01-01T00:00:00.000Z");
    const T = "2024-01-01T00:00:01.000Z";
    for (const id of ["a", "b", "c"]) {
      store({
        id,
        chat_jid: "maxcur@g.us",
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `msg ${id}`,
        timestamp: T,
      });
    }
    store({
      id: "d",
      chat_jid: "maxcur@g.us",
      sender: "user@s.whatsapp.net",
      sender_name: "User",
      content: "msg d",
      timestamp: "2024-01-01T00:00:02.000Z",
    });
    // Start after "a", cap to 2 rows
    const msgs = getAllMessagesSince("maxcur@g.us", T, "Andy", 200, "a", 2);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.id)).toEqual(["b", "c"]);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe("registered group isMain", () => {
  it("persists isMain=true through set/get round-trip", () => {
    setRegisteredGroup("main@s.whatsapp.net", {
      name: "Main Chat",
      folder: "whatsapp_main",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups["main@s.whatsapp.net"];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe("whatsapp_main");
  });

  it("omits isMain for non-main groups", () => {
    setRegisteredGroup("group@g.us", {
      name: "Family Chat",
      folder: "whatsapp_family-chat",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
    });

    const groups = getAllRegisteredGroups();
    const group = groups["group@g.us"];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- router_state pending_tail_drain round-trip ---

describe("router_state pending_tail_drain", () => {
  it("round-trips JSON array", () => {
    const jids = ["a@g.us", "b@g.us"];
    setRouterState("pending_tail_drain", JSON.stringify(jids));
    const raw = getRouterState("pending_tail_drain");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(["a@g.us", "b@g.us"]);
  });

  it("handles empty array", () => {
    setRouterState("pending_tail_drain", JSON.stringify([]));
    const raw = getRouterState("pending_tail_drain");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual([]);
  });
});

// --- Regression: trigger scanning and piping with large backlogs ---

describe("large backlog trigger scanning", () => {
  it("getAllMessagesSince without maxRows returns full backlog for trigger scanning", () => {
    const jid = "backlog@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");

    for (let i = 1; i <= 300; i++) {
      store({
        id: `bl-${i}`,
        chat_jid: jid,
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: i === 250 ? "@Andy trigger message" : `message ${i}`,
        timestamp: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      });
    }

    // Without maxRows: returns all 300 — trigger at position 250 is discoverable
    const all = getAllMessagesSince(jid, "2024-01-01T00:00:00.000Z", "Andy", 200);
    expect(all).toHaveLength(300);
    const triggerIdx = all.findIndex((m) => m.content.includes("@Andy"));
    expect(triggerIdx).toBeGreaterThanOrEqual(0);

    // With maxRows=200: returns only oldest 200 — trigger is NOT discoverable (the bug)
    const capped = getAllMessagesSince(
      jid,
      "2024-01-01T00:00:00.000Z",
      "Andy",
      200,
      undefined,
      200,
    );
    expect(capped).toHaveLength(200);
    const cappedTriggerIdx = capped.findIndex((m) => m.content.includes("@Andy"));
    expect(cappedTriggerIdx).toBe(-1);
  });

  it("getMessagesSince returns newest messages including recent trigger", () => {
    const jid = "pipe@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");

    for (let i = 1; i <= 300; i++) {
      store({
        id: `pipe-${i}`,
        chat_jid: jid,
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: i === 300 ? "@Andy trigger" : `message ${i}`,
        timestamp: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      });
    }

    // getMessagesSince (newest N): trigger is included because it's the last message
    const newest = getMessagesSince(jid, "2024-01-01T00:00:00.000Z", "Andy", 200);
    expect(newest).toHaveLength(200);
    expect(newest[newest.length - 1].content).toBe("@Andy trigger");

    // getAllMessagesSince with maxRows (oldest N): trigger is NOT included (the bug)
    const oldest = getAllMessagesSince(
      jid,
      "2024-01-01T00:00:00.000Z",
      "Andy",
      200,
      undefined,
      200,
    );
    expect(oldest).toHaveLength(200);
    const hasTrigger = oldest.some((m) => m.content.includes("@Andy"));
    expect(hasTrigger).toBe(false);
  });

  it("getMessagesSince cursor advancement leaves no residual", () => {
    const jid = "residual@g.us";
    storeChatMetadata(jid, "2024-01-01T00:00:00.000Z");

    for (let i = 1; i <= 10; i++) {
      store({
        id: `res-${i}`,
        chat_jid: jid,
        sender: "user@s.whatsapp.net",
        sender_name: "User",
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    // Fetch newest 5
    const batch = getMessagesSince(jid, "2024-01-01T00:00:00.000Z", "Andy", 5);
    expect(batch).toHaveLength(5);
    expect(batch[0].id).toBe("res-6");
    expect(batch[4].id).toBe("res-10");

    // Advance cursor to last returned message, fetch again — should be empty
    const last = batch[batch.length - 1];
    const next = getMessagesSince(jid, last.timestamp, "Andy", 5, last.id);
    expect(next).toHaveLength(0);
  });
});
