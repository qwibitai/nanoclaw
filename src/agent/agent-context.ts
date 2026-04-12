/**
 * AgentContext — shared state interface consumed by extracted manager modules.
 *
 * AgentImpl implements this interface and passes itself to managers via
 * constructor injection. This keeps the coupling explicit and testable.
 */

import type { AgentConfig } from './config.js';
import type { RuntimeConfig } from '../runtime-config.js';
import type { AgentDb } from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import type { CredentialResolver } from '../api/options.js';
import type {
  Channel,
  MountAllowlist,
  RegisteredGroup as InternalRegisteredGroup,
} from '../types.js';

export interface AgentContext {
  // ─── Identity (read-only) ───────────────────────────────────────
  readonly config: AgentConfig;
  readonly runtimeConfig: RuntimeConfig;
  readonly id: string;
  readonly name: string;

  // ─── Core subsystems ────────────────────────────────────────────
  readonly db: AgentDb;
  readonly queue: GroupQueue;

  // ─── Mutable shared state (reference types, mutated in place) ──
  readonly sessions: Record<string, string>;
  readonly registeredGroups: Record<string, InternalRegisteredGroup>;
  readonly lastAgentTimestamp: Record<string, string>;
  lastTimestamp: string;

  // ─── Channels ───────────────────────────────────────────────────
  readonly channels: Map<string, Channel>;

  // ─── Resolved config ────────────────────────────────────────────
  readonly credentialResolver: CredentialResolver | null;
  readonly resolvedMountAllowlist: MountAllowlist | null;

  // ─── Lifecycle flags ────────────────────────────────────────────
  readonly started: boolean;
  readonly stopping: boolean;

  // ─── Event forwarding ───────────────────────────────────────────
  emit(event: string, ...args: unknown[]): boolean;

  // ─── Cross-module calls ─────────────────────────────────────────
  saveState(): void;
}
