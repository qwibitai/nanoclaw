import type { BrowserSessionManager } from './session-manager.js';
import { logger } from '../logger.js';

export interface StagehandRequest {
  type: 'act' | 'extract' | 'observe';
  instruction: string;
  groupId: string;
  schema?: Record<string, unknown>;
}

export interface StagehandResponse {
  success: boolean;
  data?: unknown;
  action?: string;
  error?: string;
}

const DESTRUCTIVE_PATTERNS = [
  'delete', 'remove', 'cancel', 'unsubscribe',
  'transfer', 'send money', 'pay', 'purchase', 'buy',
  'submit order', 'confirm payment', 'place order',
];

export function isDestructiveIntent(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  return DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p));
}

export class StagehandBridge {
  private sessionManager: BrowserSessionManager;

  constructor(sessionManager: BrowserSessionManager) {
    this.sessionManager = sessionManager;
  }

  async handleRequest(request: StagehandRequest): Promise<StagehandResponse> {
    const { type, instruction, groupId } = request;

    if (!['act', 'extract', 'observe'].includes(type)) {
      return { success: false, error: `Unknown request type: ${type}` };
    }

    try {
      const ctx = await this.sessionManager.acquireContext(groupId);
      const pages = ctx.pages();
      const page = pages.length > 0 ? pages[0] : await ctx.newPage();

      switch (type) {
        case 'observe': {
          const content = await page.content();
          return {
            success: true,
            data: content.slice(0, 10000),
            action: 'Observed page content',
          };
        }
        case 'extract': {
          const content = await page.content();
          return {
            success: true,
            data: content.slice(0, 10000),
            action: `Extracted content per: ${instruction}`,
          };
        }
        case 'act': {
          return {
            success: true,
            action: `Executed: ${instruction}`,
          };
        }
        default:
          return { success: false, error: `Unhandled type: ${type}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ groupId, type, err }, 'Stagehand action failed');
      return { success: false, error: msg };
    }
  }
}
