/**
 * Store backend interface + filesystem implementation.
 *
 * The interface is stable — gateway and agent talk to the store via HTTP.
 * The backing implementation can be swapped without changing the API:
 *   Phase 1: FilesystemBackend (local dev + Fly Volume)
 *   Phase 2: TigrisPostgresBackend (S3 blobs + SQL index)
 */

import { resolve } from '@std/path';
import type { ActivityEvent, ChannelType, Session } from '../shared/types.ts';

const MAX_EVENTS = 200;

export interface StoreBackend {
  // Sessions
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  createSession(channelType: ChannelType, channelId: string): Promise<Session>;
  touchSession(id: string): Promise<void>;
  setAgentSession(id: string, agentSessionId: string): Promise<void>;
  getAgentSession(id: string): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  purgeDeletedSessions(olderThanDays: number): Promise<number>;

  // Events
  logEvent(event: Omit<ActivityEvent, 'id' | 'timestamp'>): Promise<ActivityEvent>;
  listEvents(count?: number): Promise<ActivityEvent[]>;

  // JSONL transcripts
  saveJsonl(sessionId: string, content: Uint8Array): Promise<void>;
  getJsonl(sessionId: string): Promise<Uint8Array | null>;
  getMessages(sessionId: string): Promise<{ role: string; content: string }[]>;
}

interface StoreIndex {
  sessions: Record<string, Session>;
  events: ActivityEvent[];
}

export class FilesystemBackend implements StoreBackend {
  private dir: string;
  private indexPath: string;
  private index: StoreIndex = { sessions: {}, events: [] };

  constructor(dir: string) {
    this.dir = dir;
    this.indexPath = resolve(dir, 'store.json');
    Deno.mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      const data = Deno.readTextFileSync(this.indexPath);
      const parsed = JSON.parse(data);
      this.index = {
        sessions: parsed.sessions ?? {},
        events: parsed.events ?? [],
      };
    } catch {
      this.index = { sessions: {}, events: [] };
    }
  }

  private save(): void {
    Deno.writeTextFileSync(
      this.indexPath,
      JSON.stringify(this.index, null, 2) + '\n',
    );
  }

  async listSessions(): Promise<Session[]> {
    return Object.values(this.index.sessions).filter((s) => !s.deletedAt);
  }

  async getSession(id: string): Promise<Session | null> {
    const session = this.index.sessions[id];
    if (!session || session.deletedAt) return null;
    return session;
  }

  async createSession(
    channelType: ChannelType,
    channelId: string,
  ): Promise<Session> {
    // Find an active (non-deleted) session for this channel
    const existing = Object.values(this.index.sessions).find(
      (s) =>
        s.channelType === channelType &&
        s.channelId === channelId &&
        !s.deletedAt,
    );
    if (existing) return existing;

    // Generate unique session ID (like discord-1491863568646279340)
    const uid = Date.now().toString();
    const id = `${channelType}-${uid}`;

    const session: Session = {
      id,
      channelType,
      channelId,
      lastActivity: new Date().toISOString(),
      messageCount: 0,
    };
    this.index.sessions[id] = session;
    this.save();
    return session;
  }

  async touchSession(id: string): Promise<void> {
    const session = this.index.sessions[id];
    if (session) {
      session.lastActivity = new Date().toISOString();
      session.messageCount++;
      this.save();
    }
  }

  async setAgentSession(id: string, agentSessionId: string): Promise<void> {
    const session = this.index.sessions[id];
    if (session) {
      session.agentSessionId = agentSessionId;
      this.save();
    }
  }

  async getAgentSession(id: string): Promise<string | null> {
    return this.index.sessions[id]?.agentSessionId ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.index.sessions[id];
    if (session) {
      session.deletedAt = new Date().toISOString();
      this.save();
    }
  }

  async purgeDeletedSessions(olderThanDays: number): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let purged = 0;

    for (const [id, session] of Object.entries(this.index.sessions)) {
      if (
        session.deletedAt &&
        new Date(session.deletedAt).getTime() < cutoff
      ) {
        // Remove JSONL file
        try {
          const file = resolve(this.jsonlDir(), `${id}.jsonl`);
          Deno.removeSync(file);
        } catch {
          // file may not exist
        }
        delete this.index.sessions[id];
        purged++;
      }
    }

    if (purged > 0) this.save();
    return purged;
  }

  async logEvent(
    event: Omit<ActivityEvent, 'id' | 'timestamp'>,
  ): Promise<ActivityEvent> {
    const full: ActivityEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.index.events.push(full);
    if (this.index.events.length > MAX_EVENTS) {
      this.index.events.splice(0, this.index.events.length - MAX_EVENTS);
    }
    this.save();
    return full;
  }

  async listEvents(count = 50): Promise<ActivityEvent[]> {
    return this.index.events.slice(-count).reverse();
  }

  // --- JSONL ---

  private jsonlDir(): string {
    const dir = resolve(this.dir, 'jsonl');
    Deno.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async saveJsonl(sessionId: string, content: Uint8Array): Promise<void> {
    const file = resolve(this.jsonlDir(), `${sessionId}.jsonl`);
    Deno.writeFileSync(file, content);
  }

  async getJsonl(sessionId: string): Promise<Uint8Array | null> {
    const file = resolve(this.jsonlDir(), `${sessionId}.jsonl`);
    try {
      return Deno.readFileSync(file);
    } catch {
      return null;
    }
  }

  async getMessages(
    sessionId: string,
  ): Promise<{ role: string; content: string }[]> {
    const data = await this.getJsonl(sessionId);
    if (!data) return [];
    const text = new TextDecoder().decode(data);
    return parseJsonlMessages(text);
  }
}

function parseJsonlMessages(
  jsonl: string,
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return messages;
}
