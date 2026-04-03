/**
 * Plugin Registry for NanoClaw
 * Mirrors the channel registry pattern — plugins self-register at module load time
 * via registerPlugin(). TypeScript is the single source of truth for env var injection,
 * container init script path, and binary install spec.
 */

export interface BinaryInstall {
  /** Direct download URL — fetched to dest and chmod +x */
  url?: string;
  /** Destination path inside the container image (e.g. /usr/local/bin/blogwatcher) */
  dest?: string;
  /** .tgz archive URL — specific binaries extracted from it */
  archive?: string;
  /** Binary filenames to extract from the archive */
  extract?: string[];
  /** Number of leading path components to strip when extracting (default: 0) */
  stripComponents?: number;
}

export interface Plugin {
  name: string;
  /** Env var keys read from .env and injected as -e flags into docker run */
  containerEnvKeys?: string[];
  /** Binary to bake into the container image at build time */
  binaryInstall?: BinaryInstall;
  /** Directories to pre-create with node:node ownership (needed when init scripts run as non-root) */
  containerDirectories?: string[];
}

const plugins = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin): void {
  plugins.set(plugin.name, plugin);
}

export function getRegisteredPlugins(): Plugin[] {
  return [...plugins.values()];
}

/** Collect all container env keys declared by registered plugins */
export function getPluginContainerEnvKeys(): string[] {
  return [
    ...new Set(
      [...plugins.values()].flatMap((p) => p.containerEnvKeys ?? []),
    ),
  ];
}

/** Filter env to only the keys plugins declared, for injection into docker run */
export function getPluginContainerEnv(
  env: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const plugin of plugins.values()) {
    for (const key of plugin.containerEnvKeys ?? []) {
      if (env[key] !== undefined) result[key] = env[key];
    }
  }
  return result;
}

/** Reset plugin registry — for testing only */
export function _resetForTesting(): void {
  plugins.clear();
}
