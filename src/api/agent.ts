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
import type { ZodRawShape } from 'zod';

import type { ActionCallback } from './action.js';
import type { McpServerConfig } from './options.js';
import type {
  ListTasksOptions,
  ScheduleTaskOptions,
  Task,
  TaskDetails,
  UpdateTaskOptions,
} from './task.js';

export type {
  ActionCallback,
  ActionContext,
  ActionLog,
  ActionMeta,
  BaseActionCallback,
  RegisteredAction,
} from './action.js';

/** Per-project agent runtime. Manages channels and per-chat VMs. */
export interface Agent {
  // ─── Identity ──────────────────────────────────────────────

  /** Stable internal nanoid used for runtime identifiers. */
  readonly id: string;
  /** Agent name (the key used in createAgent()). */
  readonly name: string;

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Start the agent — connects channels, begins processing messages. */
  start(): Promise<void>;
  /** Stop the agent — disconnects channels, stops processing. */
  stop(): Promise<void>;

  // ─── Channels ──────────────────────────────────────────────

  /** Add a messaging channel. Only after start(). */
  addChannel(key: string, factory: ChannelDriverFactory): Promise<void>;
  /** Remove and disconnect a channel. */
  removeChannel(key: string): Promise<void>;

  // ─── Groups ────────────────────────────────────────────────

  /** Register a group for message processing. Only after start(). */
  registerGroup(jid: string, options: RegisterGroupOptions): Promise<void>;
  /** Get a snapshot of all registered groups. Only after start(). */
  getRegisteredGroups(): RegisteredGroup[];
  /** Look up a registered group by JID. */
  getGroup(jid: string): RegisteredGroup | undefined;
  /** Get a snapshot of discovered groups. Only after start(). */
  getAvailableGroups(): AvailableGroup[];

  // ─── Messaging ─────────────────────────────────────────────

  /** Send a message to a registered chat via the appropriate channel. */
  sendMessage(jid: string, text: string): Promise<void>;

  // ─── Scheduled tasks ───────────────────────────────────────

  /** Schedule a task for a registered group. Only after start(). */
  scheduleTask(options: ScheduleTaskOptions): Promise<Task>;
  /** List scheduled tasks. Only after start(). */
  listTasks(options?: ListTasksOptions): Task[];
  /** Get one scheduled task including run history. Only after start(). */
  getTask(taskId: string): TaskDetails | undefined;
  /** Update a scheduled task. Only after start(). */
  updateTask(taskId: string, updates: UpdateTaskOptions): Promise<Task>;
  /** Pause an active scheduled task. Only after start(). */
  pauseTask(taskId: string): Promise<Task>;
  /** Resume a paused scheduled task. Only after start(). */
  resumeTask(taskId: string): Promise<Task>;
  /** Cancel and delete a scheduled task. Only after start(). */
  cancelTask(taskId: string): Promise<void>;

  // ─── Custom actions ────────────────────────────────────────

  /**
   * Registers a zero-argument action `name`, which will run the given
   * callback when the client invokes it.
   */
  action(name: string, cb: ActionCallback): this;
  /**
   * Registers a zero-argument action `name` (with a description) which
   * will run the given callback when the client invokes it.
   */
  action(name: string, description: string, cb: ActionCallback): this;
  /**
   * Registers an action with a parameter schema, whose shape determines
   * the typed first argument of the callback via zod inference.
   */
  action<Args extends ZodRawShape>(
    name: string,
    inputSchema: Args,
    cb: ActionCallback<Args>,
  ): this;
  /**
   * Registers an action `name` (with a description) taking a parameter
   * schema. This is the full form, mirroring `server.tool(name, description,
   * paramsSchema, cb)` in `@modelcontextprotocol/sdk`.
   *
   * Built-in types (schedule_task, register_group, search_actions, etc.)
   * are reserved — registering one throws immediately. Handlers may be
   * registered before or after `start()`; the HTTP server picks up new
   * registrations on the next request.
   */
  action<Args extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Args,
    cb: ActionCallback<Args>,
  ): this;

  // ─── Instructions ──────────────────────────────────────────

  /** Set agent instructions (appended to system prompt). Null to clear. */
  setInstructions(instructions: string | null): void;
  /** Get current instructions. */
  getInstructions(): string | null;

  // ─── Skills ────────────────────────────────────────────────

  /** Replace all agent-level skill source paths. Persists and re-syncs. */
  setSkills(sourcePaths: string[]): void;
  /** Add a skill directory. Validates source exists + has SKILL.md. */
  addSkill(sourcePath: string): void;
  /** Remove a skill by name (directory basename). */
  removeSkill(name: string): void;
  /** Snapshot of configured skill source paths. */
  getSkills(): string[];

  // ─── MCP servers ───────────────────────────────────────────

  /** Replace all custom MCP servers. Persists and re-syncs immediately. */
  setMcpServers(servers: Record<string, McpServerConfig>): void;
  /** Add or update a single MCP server. */
  addMcpServer(name: string, config: McpServerConfig): void;
  /** Remove a MCP server by name. */
  removeMcpServer(name: string): void;
  /** Snapshot of configured MCP servers. */
  getMcpServers(): Record<string, McpServerConfig>;

  // ─── Events ────────────────────────────────────────────────

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
