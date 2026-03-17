import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLogRow,
} from './types.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface QueueGroupSnapshot {
  jid: string;
  folder: string | null;
  active: boolean;
  pendingMessages: boolean;
  pendingTaskCount: number;
  containerName: string | null;
  retryCount: number;
}

export interface QueueStatus {
  activeCount: number;
  groups: QueueGroupSnapshot[];
}

export type { TaskRunLogRow } from './types.js';

export interface InstalledPlugin {
  name: string;
  description?: string;
  version?: string;
  groups?: string[];
  channels?: string[];
  hooks?: string[];
  channelPlugin?: boolean;
}

/** Context object passed to every plugin's onStartup hook. */
export interface PluginContext {
  logger: typeof logger;
  getRegisteredGroups(): Record<string, RegisteredGroup>;
  getSessions(): Record<string, string>;
  getChannelStatus(): { name: string; connected: boolean }[];
  getQueueStatus(): QueueStatus;
  getAllTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | undefined;
  createTask(
    fields: Omit<ScheduledTask, 'id' | 'last_run' | 'last_result'>,
  ): string;
  updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
      >
    >,
  ): void;
  getTaskRunLogs(taskId: string, limit: number): TaskRunLogRow[];
  getRecentTaskRunLogs(limit: number): TaskRunLogRow[];
  getRecentMessages(chatJid: string, limit: number): NewMessage[];
  getInstalledPlugins(): InstalledPlugin[];
}

/** The shape of an ES module in plugins/{name}/index.js that declares hooks. */
export interface PluginModule {
  onStartup?(ctx: PluginContext): Promise<void>;
  onShutdown?(): Promise<void>;
}

// ─── Internal state ───────────────────────────────────────────────────────────

let loadedModules: PluginModule[] = [];

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Scan plugins/ for hook plugins, inject their publicEnvVars, import them,
 * and call onStartup on each. Returns the loaded modules (for shutdown).
 */
export async function loadPlugins(
  ctx: PluginContext,
  cwd = process.cwd(),
): Promise<void> {
  const pluginsDir = path.join(cwd, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  const hookPlugins = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dir: path.join(pluginsDir, e.name),
      manifestPath: path.join(pluginsDir, e.name, 'plugin.json'),
      entryPath: path.join(pluginsDir, e.name, 'index.js'),
    }))
    .filter(
      ({ manifestPath, entryPath }) =>
        fs.existsSync(manifestPath) && fs.existsSync(entryPath),
    )
    .map(({ dir, manifestPath, entryPath }) => {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf-8'),
        ) as InstalledPlugin & { publicEnvVars?: string[] };
        const hooks: string[] = manifest.hooks ?? [];
        if (!hooks.includes('onStartup') && !hooks.includes('onShutdown')) {
          return null;
        }
        return { dir, manifest, entryPath };
      } catch (err) {
        logger.warn({ manifestPath, err }, 'Failed to parse plugin manifest');
        return null;
      }
    })
    .filter(Boolean) as {
    dir: string;
    manifest: InstalledPlugin & { publicEnvVars?: string[] };
    entryPath: string;
  }[];

  for (const { manifest, entryPath } of hookPlugins) {
    try {
      // Inject publicEnvVars from .env into process.env so plugins can read them
      const publicVars = manifest.publicEnvVars ?? [];
      if (publicVars.length > 0) {
        const values = readEnvFile(publicVars);
        for (const [key, value] of Object.entries(values)) {
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
      }

      const mod = (await import(entryPath)) as PluginModule;
      loadedModules.push(mod);

      if (mod.onStartup) {
        logger.info({ plugin: manifest.name }, 'Plugin startup');
        await mod.onStartup(ctx);
      }
    } catch (err) {
      logger.error({ plugin: manifest.name, err }, 'Plugin failed to load');
    }
  }
}

/** Call onShutdown on all loaded plugins in reverse load order. */
export async function shutdownPlugins(): Promise<void> {
  for (const mod of [...loadedModules].reverse()) {
    if (mod.onShutdown) {
      try {
        await mod.onShutdown();
      } catch (err) {
        logger.warn({ err }, 'Plugin shutdown error');
      }
    }
  }
  loadedModules = [];
}

// ─── PluginContext factory ────────────────────────────────────────────────────

/**
 * Build the PluginContext from live index.ts state. Called once in main()
 * after channels and subsystems are up.
 */
export function buildPluginContext(opts: {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  channels: Channel[];
  getQueueStatus: () => QueueStatus;
  db: {
    getAllTasks(): ScheduledTask[];
    getTaskById(id: string): ScheduledTask | undefined;
    createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
    updateTask(
      id: string,
      updates: Partial<
        Pick<
          ScheduledTask,
          | 'prompt'
          | 'schedule_type'
          | 'schedule_value'
          | 'next_run'
          | 'status'
        >
      >,
    ): void;
    getTaskRunLogs(taskId: string, limit: number): TaskRunLogRow[];
    getRecentTaskRunLogs(limit: number): TaskRunLogRow[];
    getRecentMessages(chatJid: string, limit: number): NewMessage[];
  };
  cwd?: string;
}): PluginContext {
  const cwd = opts.cwd ?? process.cwd();

  return {
    logger,

    getRegisteredGroups: opts.getRegisteredGroups,

    getSessions: opts.getSessions,

    getChannelStatus: () =>
      opts.channels.map((ch) => ({
        name: ch.name,
        connected: ch.isConnected(),
      })),

    getQueueStatus: opts.getQueueStatus,

    getAllTasks: opts.db.getAllTasks,

    getTaskById: opts.db.getTaskById,

    createTask(fields) {
      const id = crypto.randomUUID();
      opts.db.createTask({ ...fields, id });
      return id;
    },

    updateTask: opts.db.updateTask,

    getTaskRunLogs: opts.db.getTaskRunLogs,

    getRecentTaskRunLogs: opts.db.getRecentTaskRunLogs,

    getRecentMessages: opts.db.getRecentMessages,

    getInstalledPlugins() {
      const pluginsDir = path.join(cwd, 'plugins');
      if (!fs.existsSync(pluginsDir)) return [];
      return fs
        .readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((e) => {
          const manifestPath = path.join(pluginsDir, e.name, 'plugin.json');
          if (!fs.existsSync(manifestPath)) return [];
          try {
            return [
              JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstalledPlugin,
            ];
          } catch {
            return [];
          }
        });
    },
  };
}
