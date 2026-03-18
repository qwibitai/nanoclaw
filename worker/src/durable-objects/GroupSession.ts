/**
 * ThagomizerClaw — GroupSession Durable Object
 *
 * One instance per registered group (keyed by group folder name).
 * Manages:
 *   - Per-group message queue (prevents concurrent agent execution)
 *   - Session ID persistence
 *   - Last-processed message cursor
 *   - Processing lock (ensures one agent run at a time per group)
 *
 * Durable Objects provide:
 *   - Strong consistency (single-instance per key, globally)
 *   - Persistent storage (survives Worker restarts)
 *   - Alarm API (for scheduled wakeups)
 *   - WebSocket hibernation (for long-lived connections if needed)
 */

import type { Env, NewMessage, GroupSessionState } from '../types.js';

export class GroupSessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, '');

    switch (action) {
      case 'enqueue':
        return this.handleEnqueue(request);
      case 'get-state':
        return this.handleGetState();
      case 'set-session':
        return this.handleSetSession(request);
      case 'set-cursor':
        return this.handleSetCursor(request);
      case 'mark-processing':
        return this.handleMarkProcessing(request);
      case 'mark-done':
        return this.handleMarkDone(request);
      case 'dequeue':
        return this.handleDequeue();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const { messages }: { messages: NewMessage[] } = await request.json();

    const current = await this.getState();
    current.queuedMessages.push(...messages);
    current.lastActivity = new Date().toISOString();
    await this.saveState(current);

    // Set alarm to process queued messages if not already processing
    if (!current.isProcessing) {
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) {
        await this.state.storage.setAlarm(Date.now() + 100); // Process in 100ms
      }
    }

    return Response.json({
      queued: messages.length,
      isProcessing: current.isProcessing,
      queueLength: current.queuedMessages.length,
    });
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    return Response.json(state);
  }

  private async handleSetSession(request: Request): Promise<Response> {
    const { sessionId }: { sessionId: string } = await request.json();
    const state = await this.getState();
    state.sessionId = sessionId;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleSetCursor(request: Request): Promise<Response> {
    const { timestamp }: { timestamp: string } = await request.json();
    const state = await this.getState();
    state.lastAgentTimestamp = timestamp;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleMarkProcessing(request: Request): Promise<Response> {
    const state = await this.getState();
    if (state.isProcessing) {
      return Response.json({ ok: false, reason: 'already_processing' });
    }
    state.isProcessing = true;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleMarkDone(request: Request): Promise<Response> {
    const { sessionId, cursor }: { sessionId?: string; cursor?: string } =
      await request.json();

    const state = await this.getState();
    state.isProcessing = false;
    state.queuedMessages = []; // Clear processed messages

    if (sessionId) state.sessionId = sessionId;
    if (cursor) state.lastAgentTimestamp = cursor;

    await this.saveState(state);

    // If there are more queued messages, schedule next processing
    if (state.queuedMessages.length > 0) {
      await this.state.storage.setAlarm(Date.now() + 100);
    }

    return Response.json({ ok: true });
  }

  private async handleDequeue(): Promise<Response> {
    const state = await this.getState();
    const messages = state.queuedMessages;
    return Response.json({ messages, sessionId: state.sessionId, cursor: state.lastAgentTimestamp });
  }

  /**
   * Alarm handler — triggered when messages are queued but not being processed.
   * Submits queued messages to the processing queue.
   */
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (state.isProcessing || state.queuedMessages.length === 0) return;

    // Mark as processing and submit to queue
    state.isProcessing = true;
    await this.saveState(state);

    // The actual processing happens in the queue consumer (worker/src/index.ts)
    // We send the group folder as context so the consumer knows what to process
    const groupFolder = await this.state.storage.get<string>('groupFolder');
    if (groupFolder && this.env.MESSAGE_QUEUE) {
      await this.env.MESSAGE_QUEUE.send({
        type: 'inbound_message',
        chatJid: await this.state.storage.get<string>('chatJid') ?? '',
        messages: state.queuedMessages,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async getState(): Promise<GroupSessionState> {
    const stored = await this.state.storage.get<GroupSessionState>('state');
    return stored ?? {
      isProcessing: false,
      queuedMessages: [],
      lastActivity: new Date().toISOString(),
    };
  }

  private async saveState(state: GroupSessionState): Promise<void> {
    await this.state.storage.put('state', state);
  }
}

/**
 * RateLimiterDO — Per-group rate limiting Durable Object
 * Prevents message flooding and controls agent execution rate.
 */
export class RateLimiterDO implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, '');

    if (action === 'check') {
      return this.handleCheck(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleCheck(request: Request): Promise<Response> {
    const { key, limit, windowMs }: { key: string; limit: number; windowMs: number } =
      await request.json();

    const now = Date.now();
    const windowStart = now - windowMs;

    // Get existing timestamps for this key
    const timestamps = (await this.state.storage.get<number[]>(`timestamps:${key}`)) ?? [];

    // Remove expired timestamps
    const active = timestamps.filter((t) => t > windowStart);

    if (active.length >= limit) {
      return Response.json({ allowed: false, remaining: 0, resetAt: active[0] + windowMs });
    }

    // Record this request
    active.push(now);
    await this.state.storage.put(`timestamps:${key}`, active);

    return Response.json({ allowed: true, remaining: limit - active.length, resetAt: now + windowMs });
  }
}
