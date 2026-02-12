/**
 * Backend type definitions for NanoClaw
 * Defines the AgentBackend interface that all backends implement.
 */

import { ContainerProcess, RegisteredGroup } from '../types.js';

export type BackendType = 'apple-container' | 'docker' | 'sprites';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  discordGuildId?: string;
  serverFolder?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Interface that all agent backends must implement.
 * Backends handle running agents, IPC, and file operations.
 */
export interface AgentBackend {
  readonly name: string;

  /** Run an agent for a group. Returns when agent completes. */
  runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput>;

  /** Send a follow-up message to an active agent via IPC. Returns true if sent. */
  sendMessage(groupFolder: string, text: string): boolean;

  /** Signal an active agent to wind down. */
  closeStdin(groupFolder: string): void;

  /** Write IPC data files (tasks snapshot, groups snapshot, agent registry). */
  writeIpcData(groupFolder: string, filename: string, data: string): void;

  /** Read a file from a group's workspace. Path is relative to /workspace/group/. */
  readFile(groupFolder: string, relativePath: string): Promise<Buffer | null>;

  /** Write a file to a group's workspace. Path is relative to /workspace/group/. */
  writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void>;

  /** Initialize the backend (called once at startup). */
  initialize(): Promise<void>;

  /** Shut down the backend gracefully. */
  shutdown(): Promise<void>;
}
