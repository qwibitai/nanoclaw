/**
 * Plugin Loader
 *
 * Scans the plugins/ directory at startup and loads provider plugins.
 * Each plugin must have a host.ts (compiled to host.js) that default-exports
 * a ProviderPlugin object.
 */

import fs from 'fs';
import path from 'path';

import { AGENT_PROVIDER } from './config.js';
import { logger } from './logger.js';
import type { ProviderPlugin } from './provider-plugin.js';

const plugins = new Map<string, ProviderPlugin>();
let loaded = false;

/**
 * Resolve the host module path for a plugin.
 * Checks (in order):
 *   1. plugins/<name>/host.js  (manually compiled or bundled)
 *   2. dist/plugins/<name>/host.js  (tsc output)
 *   3. plugins/<name>/host.ts  (tsx runtime — dev mode)
 */
function resolveHostPath(pluginDir: string, entry: string): string | null {
  const srcJs = path.join(pluginDir, 'host.js');
  if (fs.existsSync(srcJs)) return srcJs;

  const distJs = path.resolve(process.cwd(), 'dist', 'plugins', entry, 'host.js');
  if (fs.existsSync(distJs)) return distJs;

  const srcTs = path.join(pluginDir, 'host.ts');
  if (fs.existsSync(srcTs)) return srcTs;

  return null;
}

/**
 * Load all plugins from the plugins/ directory.
 * Called once at startup; subsequent calls are no-ops.
 */
export async function loadPlugins(): Promise<void> {
  if (loaded) return;
  loaded = true;

  const pluginsDir = path.resolve(process.cwd(), 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    logger.debug('No plugins/ directory found');
    return;
  }

  for (const entry of fs.readdirSync(pluginsDir)) {
    const pluginDir = path.join(pluginsDir, entry);
    if (!fs.statSync(pluginDir).isDirectory()) continue;

    const hostPath = resolveHostPath(pluginDir, entry);
    if (!hostPath) {
      logger.debug({ plugin: entry }, 'Plugin directory has no host module, skipping');
      continue;
    }

    try {
      const mod = await import(hostPath);
      const plugin: ProviderPlugin = mod.default;

      if (!plugin || !plugin.name) {
        logger.warn({ plugin: entry }, 'Plugin missing default export or name');
        continue;
      }

      plugins.set(plugin.name, plugin);
      logger.info({ plugin: plugin.name }, 'Loaded provider plugin');
    } catch (err) {
      logger.error({ plugin: entry, err }, 'Failed to load provider plugin');
    }
  }
}

/**
 * Get a specific plugin by name.
 * Returns undefined if not found.
 */
export function getPlugin(name: string): ProviderPlugin | undefined {
  return plugins.get(name);
}

/**
 * Get the active plugin based on AGENT_PROVIDER config.
 * Returns null for 'claude' (built-in) or if no matching plugin found.
 */
export function getActivePlugin(): ProviderPlugin | null {
  if (!AGENT_PROVIDER || AGENT_PROVIDER === 'claude') return null;
  return plugins.get(AGENT_PROVIDER) ?? null;
}
