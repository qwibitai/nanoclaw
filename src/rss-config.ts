import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface RssFeedConfig {
  url: string;
  name?: string;
}

export interface RssChannelConfig {
  jid: string;
  feeds: RssFeedConfig[];
}

let cachedRssYaml: RssChannelConfig[] | null = null;
let cachedRssYamlMtime: number | null = null;
let cachedRssYamlPath: string | null = null;

export function readRssConfig(configPath?: string): RssChannelConfig[] {
  const resolvedPath = configPath ?? path.join(process.cwd(), 'nanoclaw.yaml');

  let mtime: number | undefined;
  try {
    mtime = fs.statSync(resolvedPath).mtimeMs;
  } catch {
    cachedRssYaml = null;
    cachedRssYamlMtime = null;
    cachedRssYamlPath = null;
    return [];
  }

  if (
    cachedRssYaml !== null &&
    cachedRssYamlPath === resolvedPath &&
    cachedRssYamlMtime === mtime
  ) {
    return cachedRssYaml;
  }

  const parsed = YAML.parse(fs.readFileSync(resolvedPath, 'utf-8')) as
    | Record<string, unknown>
    | null
    | undefined;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  const rssSection = parsed.rss;
  if (
    !rssSection ||
    typeof rssSection !== 'object' ||
    Array.isArray(rssSection)
  ) {
    return [];
  }

  const rssYaml = rssSection as { channels?: unknown };
  if (!Array.isArray(rssYaml.channels)) {
    return [];
  }

  const channels: RssChannelConfig[] = [];
  for (const entry of rssYaml.channels) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger.warn(
        { entry },
        'Invalid RSS channel entry in nanoclaw.yaml; skipping',
      );
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.jid !== 'string' || !Array.isArray(e.feeds)) {
      logger.warn(
        { entry: e },
        'RSS channel entry missing "jid" or "feeds" in nanoclaw.yaml; skipping',
      );
      continue;
    }

    const feeds: RssFeedConfig[] = [];
    for (const feed of e.feeds) {
      if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
        logger.warn(
          { feed },
          'Invalid RSS feed entry in nanoclaw.yaml; skipping',
        );
        continue;
      }
      const f = feed as Record<string, unknown>;
      if (typeof f.url !== 'string') {
        logger.warn(
          { feed: f },
          'RSS feed entry missing "url" in nanoclaw.yaml; skipping',
        );
        continue;
      }
      feeds.push({
        url: f.url,
        ...(typeof f.name === 'string' ? { name: f.name } : {}),
      });
    }

    if (feeds.length > 0) {
      channels.push({ jid: e.jid, feeds });
    }
  }

  cachedRssYaml = channels;
  cachedRssYamlMtime = mtime;
  cachedRssYamlPath = resolvedPath;

  logger.info(
    {
      channelCount: channels.length,
      feedCount: channels.reduce((s, c) => s + c.feeds.length, 0),
    },
    'RSS config loaded from nanoclaw.yaml',
  );

  return channels;
}

export function invalidateRssConfigCache(): void {
  cachedRssYaml = null;
  cachedRssYamlMtime = null;
  cachedRssYamlPath = null;
}
