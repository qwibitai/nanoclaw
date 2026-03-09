/**
 * Runtime abstraction for NanoClaw.
 *
 * All execution backends (Docker, QEMU, cloud VMs) implement these
 * interfaces so the rest of the application is runtime-agnostic.
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * A running runtime instance (container, VM, etc.).
 * Provides a uniform stdin/stdout/lifecycle API regardless of backend.
 */
export interface RuntimeInstance {
  /** Unique name for this instance (for logging and cleanup) */
  name: string;

  /** Write data to the instance's stdin equivalent */
  writeInput(data: string): void;

  /** Close the input stream */
  closeInput(): void;

  /** Kill the instance */
  kill(signal?: string): void;

  /** Register stdout data handler */
  onStdout(handler: (data: Buffer) => void): void;

  /** Register stderr data handler */
  onStderr(handler: (data: Buffer) => void): void;

  /** Register close handler */
  onClose(handler: (code: number | null) => void): void;

  /** Register error handler */
  onError(handler: (err: Error) => void): void;

  /** Stop the instance gracefully */
  stop(): Promise<void>;
}

export interface RuntimeConfig {
  /** Container/VM image identifier */
  image?: string;
  /** Per-instance timeout override */
  timeout?: number;
}

/**
 * A runtime backend that can start isolated agent instances.
 */
export interface Runtime {
  /** Runtime type identifier */
  readonly type: string;

  /** Ensure the runtime backend is available and operational */
  ensureRunning(): void;

  /** Clean up orphaned instances from previous runs */
  cleanupOrphans(): void;

  /** Start a new agent instance */
  start(
    name: string,
    mounts: VolumeMount[],
    env: Record<string, string>,
    config: RuntimeConfig,
  ): Promise<RuntimeInstance>;

  /** Return the shell command to stop an instance by name */
  stopCommand(name: string): string;
}
