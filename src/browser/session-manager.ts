import fs from 'fs';
import path from 'path';
import { createPool, type Pool } from 'generic-pool';
import type { BrowserContext } from 'playwright-core';
import { PlaywrightClient } from './playwright-client.js';
import {
  BROWSER_MAX_CONTEXTS,
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_ACQUIRE_TIMEOUT_MS,
} from '../config.js';
import { logger } from '../logger.js';
import {
  encryptBuffer,
  encryptSingleFile,
  decryptSingleFile,
} from './profile-crypto.js';

export interface ProfileOptions {
  profileKey?: Buffer;
  resolveProfileDir?: (groupId: string) => string;
}

export interface BrowserContextEvent {
  type: 'browser.context.created' | 'browser.context.closed';
  groupId: string;
  timestamp: number;
}

type EventHandler = (event: BrowserContextEvent) => void;

export class BrowserSessionManager {
  private pool: Pool<BrowserContext>;
  private client: PlaywrightClient;
  private groupContexts = new Map<string, BrowserContext>();
  private handlers = new Map<string, EventHandler[]>();
  private profileOptions: ProfileOptions;

  constructor(client?: PlaywrightClient, profileOptions?: ProfileOptions) {
    this.client = client ?? new PlaywrightClient();
    this.profileOptions = profileOptions ?? {};

    this.pool = createPool<BrowserContext>(
      {
        create: async () => this.client.newContext(),
        destroy: async (ctx) => {
          try {
            await ctx.close();
          } catch {
            /* already closed */
          }
        },
        validate: async (ctx) => {
          try {
            ctx.pages();
            return true;
          } catch {
            return false;
          }
        },
      },
      {
        max: BROWSER_MAX_CONTEXTS,
        min: 0,
        idleTimeoutMillis: BROWSER_IDLE_TIMEOUT_MS,
        acquireTimeoutMillis: BROWSER_ACQUIRE_TIMEOUT_MS,
        evictionRunIntervalMillis: 60_000,
        testOnBorrow: true,
      },
    );

    this.client.setOnDisconnect(() => this.handleDisconnect());
  }

  async acquireContext(groupId: string): Promise<BrowserContext> {
    const existing = this.groupContexts.get(groupId);
    if (existing) return existing;

    // Load encrypted profile if available
    let storageState: object | undefined;
    if (
      this.profileOptions.profileKey &&
      this.profileOptions.resolveProfileDir
    ) {
      const profileDir = this.profileOptions.resolveProfileDir(groupId);
      const stateFile = path.join(profileDir, 'state.json');
      if (fs.existsSync(stateFile)) {
        try {
          const decrypted = decryptSingleFile(
            stateFile,
            this.profileOptions.profileKey,
          );
          storageState = JSON.parse(decrypted.toString());
          logger.info(
            { groupId },
            'Browser profile loaded from encrypted state',
          );
        } catch (err) {
          logger.warn(
            { groupId, err },
            'Failed to decrypt browser profile, starting fresh',
          );
        }
      }
    }

    // Always acquire from pool to enforce max limits
    const poolCtx = await this.pool.acquire();

    let ctx: BrowserContext;
    if (storageState) {
      await this.pool.destroy(poolCtx);
      ctx = await this.client.newContext({ storageState });
    } else {
      ctx = poolCtx;
    }

    this.groupContexts.set(groupId, ctx);

    logger.info({ groupId }, 'Browser context acquired');
    this.emit({
      type: 'browser.context.created',
      groupId,
      timestamp: Date.now(),
    });
    return ctx;
  }

  async releaseContext(groupId: string): Promise<object | null> {
    const ctx = this.groupContexts.get(groupId);
    if (!ctx) return null;

    let state: object | null = null;
    try {
      state = await ctx.storageState();

      // Encrypt and save profile
      if (
        state &&
        this.profileOptions.profileKey &&
        this.profileOptions.resolveProfileDir
      ) {
        const profileDir = this.profileOptions.resolveProfileDir(groupId);
        fs.mkdirSync(profileDir, { recursive: true });
        const stateFile = path.join(profileDir, 'state.json');
        const encrypted = encryptBuffer(
          Buffer.from(JSON.stringify(state)),
          this.profileOptions.profileKey,
        );
        fs.writeFileSync(stateFile, encrypted);
        logger.info({ groupId }, 'Browser profile encrypted and saved');
      }
    } catch (err) {
      logger.warn({ groupId, err }, 'Failed to export/save storage state');
    }

    this.groupContexts.delete(groupId);
    await this.pool.release(ctx);

    logger.info({ groupId }, 'Browser context released');
    this.emit({
      type: 'browser.context.closed',
      groupId,
      timestamp: Date.now(),
    });
    return state;
  }

  getActiveGroupIds(): string[] {
    return [...this.groupContexts.keys()];
  }

  getActiveContextCount(): number {
    return this.groupContexts.size;
  }

  getContext(groupId: string): BrowserContext | null {
    return this.groupContexts.get(groupId) ?? null;
  }

  async shutdown(): Promise<void> {
    const groupIds = [...this.groupContexts.keys()];
    for (const groupId of groupIds) {
      await this.releaseContext(groupId);
    }
    await this.pool.drain();
    await this.pool.clear();
    await this.client.disconnect();
  }

  on(
    eventType: BrowserContextEvent['type'],
    handler: EventHandler,
  ): () => void {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);
    return () => {
      const current = this.handlers.get(eventType) || [];
      const idx = current.indexOf(handler);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  private emit(event: BrowserContextEvent): void {
    const handlers = this.handlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error(
          { error: err, eventType: event.type },
          'Browser event handler threw',
        );
      }
    }
  }

  private handleDisconnect(): void {
    logger.warn(
      { activeContexts: this.groupContexts.size },
      'Browser sidecar disconnected — invalidating all contexts',
    );
    for (const ctx of this.groupContexts.values()) {
      this.pool.destroy(ctx).catch(() => {});
    }
    this.groupContexts.clear();
  }
}
