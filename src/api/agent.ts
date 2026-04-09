/**
 * Agent — public interface for a per-project agent runtime.
 */

import type { ChannelDriverFactory } from './channel-driver.js';
import type { AgentEvents } from './events.js';
import type {
  AvailableGroup,
  RegisterGroupOptions,
  RegisteredGroup,
} from './group.js';

/** Per-project agent runtime. Manages channels and per-chat VMs. */
export interface Agent {
  /** Stable internal nanoid used for runtime identifiers. */
  readonly id: string;
  /** Agent name (the key used in createAgent()). */
  readonly name: string;

  /** Add a messaging channel. Only after start(). */
  addChannel(key: string, factory: ChannelDriverFactory): Promise<void>;
  /** Remove and disconnect a channel. */
  removeChannel(key: string): Promise<void>;
  /** Register a group for message processing. Only after start(). */
  registerGroup(jid: string, options: RegisterGroupOptions): Promise<void>;
  /** Get a snapshot of all registered groups. Only after start(). */
  getRegisteredGroups(): RegisteredGroup[];
  /** Get a snapshot of discovered groups. Only after start(). */
  getAvailableGroups(): AvailableGroup[];
  /** Start the agent — connects channels, begins processing messages. */
  start(): Promise<void>;
  /** Stop the agent — disconnects channels, stops processing. */
  stop(): Promise<void>;

  /** Subscribe to typed agent events. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on<K extends keyof AgentEvents & string>(
    event: K,
    listener: (...args: AgentEvents[K]) => void,
  ): any;
  /** Unsubscribe from a typed agent event. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off<K extends keyof AgentEvents & string>(
    event: K,
    listener: (...args: AgentEvents[K]) => void,
  ): any;
  /** Subscribe to a typed agent event, firing the listener at most once. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once<K extends keyof AgentEvents & string>(
    event: K,
    listener: (...args: AgentEvents[K]) => void,
  ): any;
}
