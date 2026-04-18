import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { BROWSER_CDP_URL } from '../config.js';
import { logger } from '../logger.js';

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function waitForSidecarReady(
  cdpUrl: string,
  opts: WaitOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const f = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const url = cdpUrl.replace(/\/$/, '') + '/json/version';
  while (Date.now() < deadline) {
    try {
      const res = await f(url);
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export class PlaywrightClient {
  private browser: Browser | null = null;
  private cdpUrl: string;
  private disconnectHandler: (() => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  constructor(cdpUrl?: string) {
    this.cdpUrl = cdpUrl ?? BROWSER_CDP_URL;
  }

  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;

    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    logger.info({ cdpUrl: this.cdpUrl }, 'Connected to browser sidecar');

    this.disconnectHandler = () => {
      logger.warn('Browser sidecar disconnected');
      this.browser = null;
      this.onDisconnect?.();
    };
    this.browser.on('disconnected', this.disconnectHandler);
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  setOnDisconnect(handler: () => void): void {
    this.onDisconnect = handler;
  }

  async newContext(options?: {
    storageState?: string | object;
  }): Promise<BrowserContext> {
    if (!this.browser?.isConnected()) {
      await this.connect();
    }
    return this.browser!.newContext(
      options as Parameters<Browser['newContext']>[0],
    );
  }

  async disconnect(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      // already disconnected
    }
    this.browser = null;
  }
}
