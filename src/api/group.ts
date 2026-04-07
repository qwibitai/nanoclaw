/**
 * Public group types for registration and discovery.
 */

/** A host directory mount specification. */
export interface AdditionalMount {
  /** Absolute path on host (supports ~ for home). */
  hostPath: string;
  /** Container path. Defaults to basename of hostPath, mounted at /workspace/extra/{value}. */
  containerPath?: string;
  /** Whether the mount is read-only. Default: true. */
  readonly?: boolean;
}

/** Container configuration for a group. */
export interface ContainerConfig {
  /** Additional host directories to mount into the container. */
  additionalMounts?: AdditionalMount[];
  /** Container timeout in milliseconds. Default: 300000 (5 minutes). */
  timeout?: number;
}

/** A registered group returned by the Agent API. */
export interface RegisteredGroup {
  /** Stable group/chat identifier from the channel. */
  jid: string;
  /** Human-readable group name. */
  name: string;
  /** Folder name for group data. */
  folder: string;
  /** Trigger pattern that activates the agent in this group. */
  trigger: string;
  /** ISO timestamp when the group was registered. */
  added_at: string;
  /** Container configuration overrides. */
  containerConfig?: ContainerConfig;
  /** Whether a trigger is required to activate. */
  requiresTrigger?: boolean;
  /** Whether this is the main control group. */
  isMain?: boolean;
}

/** A discovered group/chat returned by the Agent API. */
export interface AvailableGroup {
  /** Stable group/chat identifier from the channel. */
  jid: string;
  /** Human-readable name from chat metadata. */
  name: string;
  /** ISO timestamp of the most recent activity. */
  lastActivity: string;
  /** Whether this group is currently registered with the agent. */
  isRegistered: boolean;
}

/** Options for registering a group with an Agent. */
export interface RegisterGroupOptions {
  /** Human-readable group name. */
  name: string;
  /** Folder name for group data. */
  folder: string;
  /** Trigger pattern that activates the agent in this group. */
  trigger: string;
  /** Container configuration overrides. */
  containerConfig?: ContainerConfig;
  /** Whether a trigger is required to activate. Default: true. */
  requiresTrigger?: boolean;
}
