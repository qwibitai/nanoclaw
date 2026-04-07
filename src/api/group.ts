/**
 * Public types for group registration.
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
