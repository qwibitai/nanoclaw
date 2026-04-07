/**
 * Agent — public interface for a per-project agent runtime.
 */

import type { ChannelDriverFactory } from './channel-driver.js';

/** Per-project agent runtime. Manages channels and per-chat VMs. */
export interface Agent {
  /** Agent name (the key used in createAgent()). */
  readonly name: string;

  /** Add a messaging channel. Only after start(). */
  addChannel(key: string, factory: ChannelDriverFactory): Promise<void>;
  /** Remove and disconnect a channel. */
  removeChannel(key: string): Promise<void>;
  /** Start the agent — connects channels, begins processing messages. */
  start(): Promise<void>;
  /** Stop the agent — disconnects channels, stops processing. */
  stop(): Promise<void>;

  /** Subscribe to agent events. */
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
}
