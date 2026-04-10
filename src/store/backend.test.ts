/**
 * Smoke tests for FilesystemBackend.
 *
 * Tests session CRUD, soft-delete, purge, JSONL persistence,
 * event logging, and unique session IDs.
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { FilesystemBackend } from './backend.ts';

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: 'nexus-test-' });
}

// --- Session CRUD ---

Deno.test('createSession generates unique timestamp-based ID', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'default');

  assert(session.id.startsWith('web-chat-'), `Expected web-chat- prefix, got ${session.id}`);
  assertEquals(session.channelType, 'web-chat');
  assertEquals(session.channelId, 'default');
  assertEquals(session.messageCount, 0);
  assert(!session.deletedAt);
});

Deno.test('createSession returns existing active session for same channel', async () => {
  const backend = new FilesystemBackend(tempDir());
  const s1 = await backend.createSession('discord', 'chan-123');
  const s2 = await backend.createSession('discord', 'chan-123');

  assertEquals(s1.id, s2.id);
});

Deno.test('createSession creates new session for different channel', async () => {
  const backend = new FilesystemBackend(tempDir());
  const s1 = await backend.createSession('discord', 'chan-123');

  // Small delay to ensure different timestamp
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await backend.createSession('discord', 'chan-456');

  assert(s1.id !== s2.id, 'Expected different IDs for different channels');
});

Deno.test('getSession returns session by ID', async () => {
  const backend = new FilesystemBackend(tempDir());
  const created = await backend.createSession('web-chat', 'test');
  const fetched = await backend.getSession(created.id);

  assertExists(fetched);
  assertEquals(fetched!.id, created.id);
  assertEquals(fetched!.channelType, 'web-chat');
});

Deno.test('getSession returns null for non-existent ID', async () => {
  const backend = new FilesystemBackend(tempDir());
  const result = await backend.getSession('does-not-exist');

  assertEquals(result, null);
});

Deno.test('listSessions returns all active sessions', async () => {
  const backend = new FilesystemBackend(tempDir());
  await backend.createSession('web-chat', 'a');
  await new Promise((r) => setTimeout(r, 5));
  await backend.createSession('discord', 'b');

  const sessions = await backend.listSessions();
  assertEquals(sessions.length, 2);
});

Deno.test('touchSession increments messageCount and updates lastActivity', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');
  const originalActivity = session.lastActivity;

  await new Promise((r) => setTimeout(r, 5));
  await backend.touchSession(session.id);

  const updated = await backend.getSession(session.id);
  assertExists(updated);
  assertEquals(updated!.messageCount, 1);
  assert(updated!.lastActivity > originalActivity);
});

Deno.test('setAgentSession and getAgentSession persist agent SDK session ID', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');

  await backend.setAgentSession(session.id, 'agent-uuid-123');
  const agentId = await backend.getAgentSession(session.id);

  assertEquals(agentId, 'agent-uuid-123');
});

// --- Soft Delete ---

Deno.test('deleteSession sets deletedAt (soft delete)', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');

  await backend.deleteSession(session.id);

  // Session is hidden from normal queries
  const fetched = await backend.getSession(session.id);
  assertEquals(fetched, null);

  const listed = await backend.listSessions();
  assertEquals(listed.length, 0);
});

Deno.test('createSession after delete creates new session with new ID', async () => {
  const backend = new FilesystemBackend(tempDir());
  const s1 = await backend.createSession('web-chat', 'default');
  const originalId = s1.id;

  await backend.deleteSession(s1.id);

  // Small delay for unique timestamp
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await backend.createSession('web-chat', 'default');

  assert(s2.id !== originalId, `Expected new ID, got same: ${s2.id}`);
  assertEquals(s2.messageCount, 0);
  assert(!s2.deletedAt);
});

Deno.test('deleted session JSONL is not accessible via new session', async () => {
  const backend = new FilesystemBackend(tempDir());
  const s1 = await backend.createSession('web-chat', 'default');

  // Save JSONL to old session
  const content = new TextEncoder().encode('{"type":"user","message":{"content":"hello"}}');
  await backend.saveJsonl(s1.id, content);

  // Delete and recreate
  await backend.deleteSession(s1.id);
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await backend.createSession('web-chat', 'default');

  // New session should not have old JSONL
  const jsonl = await backend.getJsonl(s2.id);
  assertEquals(jsonl, null);
});

// --- Purge ---

Deno.test('purgeDeletedSessions removes old deleted sessions', async () => {
  const dir = tempDir();
  const backend = new FilesystemBackend(dir);
  const session = await backend.createSession('web-chat', 'test');

  // Save some JSONL
  await backend.saveJsonl(session.id, new TextEncoder().encode('test data'));

  // Delete it, then backdate deletedAt to 31 days ago
  await backend.deleteSession(session.id);
  // Access internal state to backdate (test-only hack)
  const indexPath = `${dir}/store.json`;
  const index = JSON.parse(Deno.readTextFileSync(indexPath));
  index.sessions[session.id].deletedAt = new Date(
    Date.now() - 31 * 24 * 60 * 60 * 1000,
  ).toISOString();
  Deno.writeTextFileSync(indexPath, JSON.stringify(index));

  // Reload and purge with 30-day threshold
  const backend2 = new FilesystemBackend(dir);
  const purged = await backend2.purgeDeletedSessions(30);
  assertEquals(purged, 1);

  // Verify JSONL is also gone
  const jsonl = await backend2.getJsonl(session.id);
  assertEquals(jsonl, null);
});

Deno.test('purgeDeletedSessions does not purge recently deleted sessions', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');

  await backend.deleteSession(session.id);

  // Purge with 30 days — recently deleted should survive
  const purged = await backend.purgeDeletedSessions(30);
  assertEquals(purged, 0);
});

// --- JSONL ---

Deno.test('saveJsonl and getJsonl round-trip binary content', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');

  const content = new TextEncoder().encode('line1\nline2\n');
  await backend.saveJsonl(session.id, content);

  const retrieved = await backend.getJsonl(session.id);
  assertExists(retrieved);
  assertEquals(new TextDecoder().decode(retrieved!), 'line1\nline2\n');
});

Deno.test('getJsonl returns null for missing JSONL', async () => {
  const backend = new FilesystemBackend(tempDir());
  const result = await backend.getJsonl('nonexistent');
  assertEquals(result, null);
});

Deno.test('getMessages parses JSONL user and assistant messages', async () => {
  const backend = new FilesystemBackend(tempDir());
  const session = await backend.createSession('web-chat', 'test');

  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } }),
    JSON.stringify({ type: 'system', subtype: 'init' }),
  ].join('\n');

  await backend.saveJsonl(session.id, new TextEncoder().encode(jsonl));
  const messages = await backend.getMessages(session.id);

  assertEquals(messages.length, 2);
  assertEquals(messages[0], { role: 'user', content: 'hello' });
  assertEquals(messages[1], { role: 'assistant', content: 'hi there' });
});

// --- Events ---

Deno.test('logEvent creates event with ID and timestamp', async () => {
  const backend = new FilesystemBackend(tempDir());
  const event = await backend.logEvent({
    type: 'system',
    channel: 'system',
    groupId: 'system',
    summary: 'test event',
  });

  assertExists(event.id);
  assertExists(event.timestamp);
  assertEquals(event.type, 'system');
  assertEquals(event.summary, 'test event');
});

Deno.test('listEvents returns events in reverse chronological order', async () => {
  const backend = new FilesystemBackend(tempDir());
  await backend.logEvent({ type: 'system', channel: 'sys', groupId: 'sys', summary: 'first' });
  await backend.logEvent({ type: 'system', channel: 'sys', groupId: 'sys', summary: 'second' });

  const events = await backend.listEvents();
  assertEquals(events.length, 2);
  assertEquals(events[0].summary, 'second');
  assertEquals(events[1].summary, 'first');
});

Deno.test('listEvents respects count parameter', async () => {
  const backend = new FilesystemBackend(tempDir());
  for (let i = 0; i < 10; i++) {
    await backend.logEvent({ type: 'system', channel: 'sys', groupId: 'sys', summary: `event ${i}` });
  }

  const events = await backend.listEvents(3);
  assertEquals(events.length, 3);
});

// --- Persistence ---

Deno.test('data survives backend reload from same directory', async () => {
  const dir = tempDir();

  // Create data with first backend instance
  const b1 = new FilesystemBackend(dir);
  const session = await b1.createSession('web-chat', 'persist-test');
  await b1.touchSession(session.id);
  await b1.logEvent({ type: 'system', channel: 'sys', groupId: 'sys', summary: 'persisted' });

  // Load fresh backend from same directory
  const b2 = new FilesystemBackend(dir);
  const loaded = await b2.getSession(session.id);
  assertExists(loaded);
  assertEquals(loaded!.messageCount, 1);

  const events = await b2.listEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0].summary, 'persisted');
});
