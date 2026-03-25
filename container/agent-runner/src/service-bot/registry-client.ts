/**
 * Bot Registry Client — fetches bot configs from the telemetry service's
 * registry API and caches them locally. Replaces the hardcoded BOTS object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotConfig } from './config.js';

export interface RegistryBotEntry {
  bot_id: string;
  name: string;
  config: {
    ssh_target: string;
    container: string;
    framework: string;
    config_paths: string[];
    github_issues_repo: string;
    github_source_repo: string;
    local_project_dir: string;
    notes?: string[];
    log_path?: string;
    watch_configs?: string[];
  };
}

export interface RefreshResult {
  botsLoaded: number;
  added: string[];
  removed: string[];
  source: 'api' | 'cache';
}

interface CacheFile {
  fetchedAt: string;
  bots: Record<string, BotConfig>;
}

function mapToBotConfig(entry: RegistryBotEntry): BotConfig {
  const c = entry.config;
  return {
    name: entry.name,
    sshTarget: c.ssh_target,
    container: c.container,
    configPaths: c.config_paths,
    githubIssuesRepo: c.github_issues_repo,
    githubSourceRepo: c.github_source_repo,
    localProjectDir: c.local_project_dir,
    framework: c.framework,
    notes: c.notes ?? [],
    telemetryBotId: entry.bot_id,
  };
}

export class BotRegistry {
  private bots: Record<string, BotConfig> = {};
  private registryUrl: string;
  private cachePath: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(registryUrl: string, cachePath: string) {
    this.registryUrl = registryUrl.replace(/\/$/, '');
    this.cachePath = cachePath;
  }

  /** Initialize: fetch from API, fall back to file cache. */
  async init(): Promise<void> {
    try {
      await this.fetchFromApi();
    } catch {
      this.loadFromCache();
      if (Object.keys(this.bots).length === 0) {
        // No cache either — retry with backoff
        await this.retryInit();
      }
    }
  }

  private async retryInit(): Promise<void> {
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.fetchFromApi();
        return;
      } catch {
        // continue retrying
      }
    }
    console.error('[registry] Failed to load configs after retries. Starting with empty config.');
  }

  /** Start background polling every pollMs (default 5 min). */
  startPolling(pollMs = 5 * 60 * 1000): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      this.refresh().catch((err) => {
        console.error(`[registry] Background refresh failed: ${err.message}`);
      });
    }, pollMs);
    // Don't keep process alive just for polling
    if (this.pollInterval.unref) this.pollInterval.unref();
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Get a bot config by name (case-insensitive). */
  getBot(name: string): BotConfig {
    const key = name.toLowerCase();
    const config = this.bots[key];
    if (!config) {
      const available = Object.values(this.bots)
        .map((b) => b.name)
        .join(', ');
      throw new Error(
        `Unknown bot "${name}". Available bots: ${available || '(none — registry may be loading)'}`,
      );
    }
    return config;
  }

  /** Get all bot configs. */
  getAllBots(): Record<string, BotConfig> {
    return { ...this.bots };
  }

  /** Force refresh from API. Returns diff. */
  async refresh(): Promise<RefreshResult> {
    const oldKeys = new Set(Object.keys(this.bots));
    try {
      await this.fetchFromApi();
      const newKeys = new Set(Object.keys(this.bots));
      const added = [...newKeys].filter((k) => !oldKeys.has(k));
      const removed = [...oldKeys].filter((k) => !newKeys.has(k));
      return {
        botsLoaded: Object.keys(this.bots).length,
        added,
        removed,
        source: 'api',
      };
    } catch {
      return {
        botsLoaded: Object.keys(this.bots).length,
        added: [],
        removed: [],
        source: 'cache',
      };
    }
  }

  private async fetchFromApi(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.registryUrl}/api/bots/configs`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Registry API returned ${res.status}`);
      }
      const entries = (await res.json()) as RegistryBotEntry[];
      const newBots: Record<string, BotConfig> = {};
      for (const entry of entries) {
        const key = entry.name.toLowerCase();
        newBots[key] = mapToBotConfig(entry);
      }
      this.bots = newBots;
      this.saveToCache();
    } finally {
      clearTimeout(timeout);
    }
  }

  private loadFromCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const cache: CacheFile = JSON.parse(raw);
      this.bots = cache.bots;
      console.error(
        `[registry] Loaded ${Object.keys(this.bots).length} bots from cache (fetched: ${cache.fetchedAt})`,
      );
    } catch {
      // corrupt cache — ignore
    }
  }

  private saveToCache(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cache: CacheFile = {
        fetchedAt: new Date().toISOString(),
        bots: this.bots,
      };
      fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
    } catch {
      // non-fatal — cache write failure shouldn't block operation
    }
  }
}
