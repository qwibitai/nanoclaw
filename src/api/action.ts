/**
 * Custom actions — host-registered RPC endpoints invoked from container
 * agents over the HTTP transport in `src/agent/actions-http.ts`.
 *
 * Signatures mirror `@modelcontextprotocol/sdk`'s `McpServer.tool`:
 *
 *   agent.action(
 *     'search_crm',
 *     'Look up a customer',
 *     { query: z.string().describe('search terms') },
 *     async ({ query }, ctx) => { ... },
 *   );
 *
 * Generic parameters give full type inference: `{ query: z.string() }` yields
 * `args.query: string` inside the callback via `z.output<z.ZodObject<Args>>`.
 * The host validates every incoming call against the shape, and emits JSON
 * Schema on the /search wire format so container-side discovery can describe
 * the action to the model.
 */

import type { ZodRawShape, z } from 'zod';

/** Narrow log facade exposed to action callbacks — subset of pino. */
export interface ActionLog {
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
}

/**
 * Per-invocation context passed to an action callback.
 *
 * Trust asymmetry: `sourceGroup` and `isMain` come from the bearer-token
 * binding and are tamper-proof. `jid` is container-supplied (payload) and
 * should be treated as an assertion — validate before using it for any
 * authorization decision.
 */
export interface ActionContext {
  jid: string | undefined;
  sourceGroup: string;
  isMain: boolean;
  log: ActionLog;
}

/**
 * Base callback shape for an action handler.
 *
 * Mirrors `BaseToolCallback` in `@modelcontextprotocol/sdk`: when the action
 * was registered with a zod shape, `args` is inferred from the shape; when
 * it was registered without a schema, the callback takes only `ctx`.
 */
export type BaseActionCallback<
  ResultT,
  Extra,
  Args extends undefined | ZodRawShape,
> = Args extends ZodRawShape
  ? (args: z.output<z.ZodObject<Args>>, extra: Extra) => ResultT | Promise<ResultT>
  : (extra: Extra) => ResultT | Promise<ResultT>;

/**
 * Callback for an action handler registered with `agent.action()`.
 *
 * `Args` defaults to `undefined` (no schema, `ctx`-only callback). Passing a
 * `ZodRawShape` yields a typed callback whose first argument is the parsed
 * payload, and whose second is the `ActionContext`.
 */
export type ActionCallback<
  Args extends undefined | ZodRawShape = undefined,
> = BaseActionCallback<unknown, ActionContext, Args>;

/**
 * Metadata describing a registered action, surfaced to container agents via
 * the built-in `search_actions` discovery endpoint.
 */
export interface ActionMeta {
  description?: string;
  /** Zod raw shape — validated on /call, emitted as JSON Schema on /search. */
  inputSchema?: ZodRawShape;
}

/**
 * Storage-level entry: a registered action keeps its metadata plus a
 * non-generic callback wrapper that takes validated args and ctx. Typed
 * handlers registered via the positional overloads are wrapped to match
 * this shape at registration time.
 */
export interface RegisteredAction {
  description?: string;
  inputSchema?: ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    ctx: ActionContext,
  ) => Promise<unknown> | unknown;
}

/**
 * Built-in IPC message types — cannot be used as custom action names.
 * These operate on scheduled tasks, group registration, or are reserved
 * for the container MCP shim tools.
 */
export const RESERVED_ACTION_TYPES = [
  'message',
  'schedule_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'update_task',
  'refresh_groups',
  'register_group',
  'search_actions',
  'call_action',
] as const;

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_ACTION_TYPES);

/** Throws if `name` collides with a reserved built-in type. */
export function assertCustomActionName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid action name: ${String(name)}`);
  }
  if (RESERVED_SET.has(name)) {
    throw new Error(
      `Cannot register custom action "${name}" — reserved built-in`,
    );
  }
}
