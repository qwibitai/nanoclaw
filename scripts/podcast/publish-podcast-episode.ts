import fs from 'fs';
import path from 'path';

import { uploadToR2 } from './lib/r2-upload.ts';

type Env = Record<string, string>;

interface PodcastMeta {
  title: string;
  description: string;
  author: string;
  email: string;
  language: string;
  artworkUrl: string;
  category: string;
}

interface FeedConfig {
  feedKey: string;
  rssFilename: string;
  r2Prefix: string;
  guidPrefix: string;
  voice: string;
  ttsModel?: string;
  speed?: number;
  podcast: PodcastMeta;
}

interface Args {
  feed: string;
  title: string;
  summary: string;
  scriptFile?: string;
  mp3File?: string;
  slug?: string;
  duration?: string;
}

interface ProducedEpisodeOptions {
  root: string;
  feed: FeedConfig;
  seriesKey: string;
  slug: string;
  title: string;
  summary: string;
  script: string | null;
  sourceScriptPath: string | null;
  copiedScriptPath: string | null;
  mp3Path: string;
  mp3Url: string;
  feedUrl: string;
  guid: string;
  mp3Bytes: number;
  publishedAt: Date;
  duration?: string;
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  node --experimental-strip-types scripts/podcast/publish-podcast-episode.ts \\',
      '    --feed kids --title "Title" --summary "Summary" --script-file path/to/script.txt',
      '',
      'Required:',
      '  --feed <key>         feeds/<key>.config.json must exist',
      '  --title              Episode title',
      '  --summary            Episode description',
      '',
      'Provide one of:',
      '  --script-file PATH   Generates MP3 via OpenAI TTS',
      '  --mp3-file PATH      Skips TTS, uses an already-generated MP3',
      '',
      'Optional:',
      '  --slug custom-slug   Default: <YYYY-MM-DD>-<slugified-title>',
      '  --duration HH:MM:SS  Adds <itunes:duration>',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--')) usage();
    if (!value || value.startsWith('--')) usage();
    i++;
    switch (key) {
      case '--feed':
        out.feed = value;
        break;
      case '--title':
        out.title = value;
        break;
      case '--summary':
        out.summary = value;
        break;
      case '--script-file':
        out.scriptFile = value;
        break;
      case '--mp3-file':
        out.mp3File = value;
        break;
      case '--slug':
        out.slug = value;
        break;
      case '--duration':
        out.duration = value;
        break;
      default:
        usage();
    }
  }
  if (!out.feed || !out.title || !out.summary) usage();
  if (Boolean(out.scriptFile) === Boolean(out.mp3File)) {
    console.error('Provide exactly one of --script-file or --mp3-file.');
    usage();
  }
  return out as Args;
}

function readEnv(keys: string[]): Env {
  const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  const wanted = new Set(keys);
  const out: Env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  const missing = keys.filter((k) => !out[k]);
  if (missing.length) throw new Error(`Missing required env keys: ${missing.join(', ')}`);
  return out;
}

function readEnvOrProcess(keys: string[]): Env {
  const fromProcess: Env = {};
  let allInProcess = true;
  for (const key of keys) {
    const v = process.env[key];
    if (v === undefined || v === '') {
      allInProcess = false;
      break;
    }
    fromProcess[key] = v;
  }
  if (allInProcess) return fromProcess;
  return readEnv(keys);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function podRoot(): string {
  // Host: <repo>/groups/thedius_pod
  // Container: /workspace/agent  (cwd when agent invokes the script)
  // Detect by checking for the group's container.json next to cwd.
  if (fs.existsSync(path.join(process.cwd(), 'container.json'))) {
    return process.cwd();
  }
  return path.join(process.cwd(), 'groups', 'thedius_pod');
}

function loadFeedConfig(feedKey: string): FeedConfig {
  const root = podRoot();
  const configPath = path.join(root, 'podcast', 'feeds', `${feedKey}.config.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No feed config at ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const cfg: FeedConfig = {
    feedKey: raw.feedKey ?? feedKey,
    rssFilename: raw.rssFilename ?? `${feedKey}-feed.rss`,
    r2Prefix: raw.r2Prefix ?? feedKey,
    guidPrefix: raw.guidPrefix ?? `${feedKey}-`,
    voice: raw.voice ?? 'onyx',
    ttsModel: raw.ttsModel,
    speed: raw.speed,
    podcast: {
      title: raw.podcast.title,
      description: raw.podcast.description,
      author: raw.podcast.author ?? 'Thedius',
      email: raw.podcast.email ?? 'thedius@briefing.ai',
      language: raw.podcast.language ?? 'en-gb',
      artworkUrl: raw.podcast.artworkUrl,
      category: raw.podcast.category ?? 'News',
    },
  };
  return cfg;
}

function ensureFeedExists(feedPath: string, feed: FeedConfig, feedUrl: string): void {
  if (fs.existsSync(feedPath)) return;
  const skeleton = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feed.podcast.title)}</title>
    <link>${escapeXml(feedUrl)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(feed.podcast.description)}</description>
    <language>${escapeXml(feed.podcast.language)}</language>
    <itunes:author>${escapeXml(feed.podcast.author)}</itunes:author>
    <itunes:summary>${escapeXml(feed.podcast.description)}</itunes:summary>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="${escapeXml(feed.podcast.category)}"/>
    <itunes:image href="${escapeXml(feed.podcast.artworkUrl)}"/>
    <itunes:owner>
      <itunes:name>${escapeXml(feed.podcast.author)}</itunes:name>
      <itunes:email>${escapeXml(feed.podcast.email)}</itunes:email>
    </itunes:owner>
  </channel>
</rss>
`;
  fs.mkdirSync(path.dirname(feedPath), { recursive: true });
  fs.writeFileSync(feedPath, skeleton);
}

function ensureUniqueGuid(feedXml: string, guid: string): void {
  if (feedXml.includes(`<guid>${escapeXml(guid)}</guid>`) || feedXml.includes(`<guid isPermaLink="false">${escapeXml(guid)}</guid>`)) {
    throw new Error(`Feed already contains guid: ${guid}`);
  }
}

function insertItem(feedXml: string, itemXml: string): string {
  if (!feedXml.includes('</channel>')) throw new Error('Invalid RSS feed: missing </channel>');
  return feedXml.replace(/\n\s*<\/channel>/, `\n${itemXml}\n  </channel>`);
}

const PRODUCED_SERIES_KEYS = new Set(['tech', 'markets', 'stream', 'iran', 'kids']);

function inferSeriesKey(feed: FeedConfig, slug: string, title: string): string {
  const slugPrefix = slug.split('-')[0];
  if (slugPrefix && PRODUCED_SERIES_KEYS.has(slugPrefix)) return slugPrefix;

  const lowerTitle = title.toLowerCase();
  for (const key of PRODUCED_SERIES_KEYS) {
    if (lowerTitle.includes(`thedius ${key}`) || lowerTitle.startsWith(`${key} `)) return key;
  }

  return feed.feedKey;
}

function relativeToGroupRoot(root: string, filePath: string | null): string | null {
  if (!filePath) return null;
  return path.relative(root, filePath).split(path.sep).join('/');
}

function scriptToMarkdown(title: string, script: string): string {
  const paragraphs = script
    .trim()
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [`# ${title}`, '', ...paragraphs].join('\n\n') + '\n';
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function collectMetadataFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMetadataFiles(child));
    } else if (entry.isFile() && entry.name === 'metadata.json') {
      out.push(child);
    }
  }
  return out;
}

function rebuildProducedIndex(root: string): void {
  const producedRoot = path.join(root, 'podcast', 'library', 'produced');
  const metadataFiles = collectMetadataFiles(producedRoot);
  const episodes = metadataFiles
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
    .sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')));

  const index = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    count: episodes.length,
    episodes: episodes.map((episode) => ({
      seriesKey: episode.seriesKey,
      slug: episode.slug,
      title: episode.title,
      publishedAt: episode.publishedAt,
      publishedFeedKey: episode.publishedFeedKey,
      status: episode.status,
      transcriptPath: episode.transcript?.path ? `${episode.seriesKey}/${episode.slug}/${episode.transcript.path}` : null,
      cleanPath: episode.transcript?.cleanPath ? `${episode.seriesKey}/${episode.slug}/${episode.transcript.cleanPath}` : null,
      mp3Url: episode.mp3Url,
      feedUrl: episode.feedUrl,
      guid: episode.guid,
    })),
  };

  fs.mkdirSync(producedRoot, { recursive: true });
  fs.writeFileSync(path.join(producedRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const rows = index.episodes.map((episode) =>
    [
      escapeMarkdownCell(episode.publishedAt?.slice(0, 10) ?? ''),
      escapeMarkdownCell(episode.seriesKey ?? ''),
      escapeMarkdownCell(episode.title ?? ''),
      escapeMarkdownCell(episode.slug ?? ''),
      episode.transcriptPath ? `[transcript](${episode.transcriptPath})` : '',
      episode.mp3Url ? `[mp3](${episode.mp3Url})` : '',
    ].join(' | '),
  );
  fs.writeFileSync(
    path.join(producedRoot, 'index.md'),
    [
      '# Produced Episodes',
      '',
      `Updated: ${index.updatedAt}`,
      '',
      '| Date | Series | Title | Slug | Transcript | Audio |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map((row) => `| ${row} |`),
      '',
    ].join('\n'),
  );
}

function writeProducedEpisodeRecord(opts: ProducedEpisodeOptions): string {
  const producedDir = path.join(opts.root, 'podcast', 'library', 'produced', opts.seriesKey, opts.slug);
  fs.mkdirSync(producedDir, { recursive: true });

  const transcript = opts.script
    ? {
        path: 'transcript.txt',
        cleanPath: 'clean.md',
        words: opts.script.split(/\s+/).filter(Boolean).length,
      }
    : null;

  if (opts.script) {
    fs.writeFileSync(path.join(producedDir, 'transcript.txt'), `${opts.script.trim()}\n`);
    fs.writeFileSync(path.join(producedDir, 'clean.md'), scriptToMarkdown(opts.title, opts.script));
  }

  const metadata = {
    schemaVersion: 1,
    kind: 'produced_episode',
    seriesKey: opts.seriesKey,
    publishedFeedKey: opts.feed.feedKey,
    slug: opts.slug,
    title: opts.title,
    summary: opts.summary,
    publishedAt: opts.publishedAt.toISOString(),
    guid: opts.guid,
    mp3Url: opts.mp3Url,
    feedUrl: opts.feedUrl,
    status: opts.script ? 'published_with_transcript' : 'published_no_transcript',
    transcript,
    local: {
      sourceScriptPath: relativeToGroupRoot(opts.root, opts.sourceScriptPath),
      copiedScriptPath: relativeToGroupRoot(opts.root, opts.copiedScriptPath),
      mp3Path: relativeToGroupRoot(opts.root, opts.mp3Path),
    },
    audio: {
      bytes: opts.mp3Bytes,
      duration: opts.duration ?? null,
      voice: opts.feed.voice,
      model: opts.feed.ttsModel ?? 'tts-1-hd',
      speed: opts.feed.speed ?? 1.1,
    },
    createdBy: 'publish-podcast-episode',
  };

  fs.writeFileSync(path.join(producedDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  rebuildProducedIndex(opts.root);
  return producedDir;
}

// Split text into chunks at sentence boundaries, respecting an OpenAI TTS
// max-input limit (4096 chars). Sentences longer than the cap are hard-split.
function chunkText(text: string, maxChars = 4000): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length <= maxChars) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) chunks.push(current);
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) {
          chunks.push(sentence.slice(i, i + maxChars));
        }
        current = '';
      } else {
        current = sentence;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function generateSpeech(
  apiKey: string,
  script: string,
  outPath: string,
  voice: string,
  model: string,
  speed: number,
): Promise<void> {
  const chunks = chunkText(script);
  const audioParts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunks.length > 1) {
      console.log(`TTS chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: chunk,
        response_format: 'mp3',
        speed,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`OpenAI TTS failed (chunk ${i + 1}/${chunks.length}): ${res.status} ${detail.slice(0, 300)}`);
    }

    audioParts.push(Buffer.from(await res.arrayBuffer()));
  }

  const bytes = Buffer.concat(audioParts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
  console.log(`Generated MP3: ${outPath} (${bytes.length} bytes, ${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const feed = loadFeedConfig(args.feed);

  const env = readEnvOrProcess([
    'PODCAST_OPENAI_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_BUCKET',
    'CLOUDFLARE_R2_PUBLIC_BASE_URL',
  ]);

  const root = podRoot();
  const dateStr = new Date().toISOString().slice(0, 10);
  const slug = args.slug ? slugify(args.slug) : `${dateStr}-${slugify(args.title)}`;
  if (!slug) throw new Error('Could not derive a valid slug.');

  const outputDir = path.join(root, 'podcast', 'output', feed.feedKey);
  const scriptsDir = path.join(root, 'podcast', 'scripts', feed.feedKey);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  let mp3Path: string;
  let script: string | null = null;
  let sourceScriptPath: string | null = null;
  let copiedScriptPath: string | null = null;
  if (args.scriptFile) {
    const scriptPath = path.resolve(args.scriptFile);
    script = fs.readFileSync(scriptPath, 'utf8').trim();
    if (!script) throw new Error(`Script file is empty: ${scriptPath}`);
    sourceScriptPath = scriptPath;
    copiedScriptPath = path.join(scriptsDir, `${slug}.txt`);
    fs.copyFileSync(scriptPath, copiedScriptPath);
    mp3Path = path.join(outputDir, `${slug}.mp3`);
    await generateSpeech(
      env.PODCAST_OPENAI_API_KEY!,
      script,
      mp3Path,
      feed.voice,
      feed.ttsModel ?? 'tts-1-hd',
      feed.speed ?? 1.1,
    );
  } else {
    mp3Path = path.resolve(args.mp3File!);
    if (!fs.existsSync(mp3Path)) throw new Error(`MP3 file not found: ${mp3Path}`);
  }

  const mp3Body = fs.readFileSync(mp3Path);
  const publicBase = env.CLOUDFLARE_R2_PUBLIC_BASE_URL!.replace(/\/+$/, '');
  const mp3ObjectKey = `${feed.r2Prefix}/${slug}.mp3`;
  const mp3Url = `${publicBase}/${mp3ObjectKey}`;
  const feedPath = path.join(root, 'podcast', 'feeds', feed.rssFilename);
  const feedUrl = `${publicBase}/${feed.rssFilename}`;
  ensureFeedExists(feedPath, feed, feedUrl);
  const feedXml = fs.readFileSync(feedPath, 'utf8');
  const guid = `${feed.guidPrefix}${slug}`;
  const publishedAt = new Date();
  ensureUniqueGuid(feedXml, guid);

  await uploadToR2({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    bucket: env.CLOUDFLARE_R2_BUCKET!,
    objectKey: mp3ObjectKey,
    body: mp3Body,
    contentType: 'audio/mpeg',
  });

  const durationXml = args.duration ? `\n      <itunes:duration>${escapeXml(args.duration)}</itunes:duration>` : '';
  const itemXml = [
    '    <item>',
    `      <title>${escapeXml(args.title)}</title>`,
    `      <description>${escapeXml(args.summary)}</description>`,
    `      <pubDate>${publishedAt.toUTCString()}</pubDate>`,
    `      <guid>${escapeXml(guid)}</guid>`,
    `      <enclosure url="${escapeXml(mp3Url)}" length="${mp3Body.length}" type="audio/mpeg"/>${durationXml}`,
    `      <itunes:summary>${escapeXml(args.summary)}</itunes:summary>`,
    '      <itunes:explicit>false</itunes:explicit>',
    '    </item>',
  ].join('\n');

  const updatedFeed = insertItem(feedXml, itemXml);
  fs.writeFileSync(feedPath, updatedFeed);

  await uploadToR2({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    bucket: env.CLOUDFLARE_R2_BUCKET!,
    objectKey: feed.rssFilename,
    body: Buffer.from(updatedFeed),
    contentType: 'application/rss+xml; charset=utf-8',
  });

  const mp3Check = await fetch(mp3Url, { method: 'HEAD' });
  const feedCheck = await fetch(feedUrl, { method: 'HEAD' });
  console.log(`Feed: ${feed.feedKey}`);
  console.log(`Episode MP3: ${mp3Url}`);
  console.log(`RSS feed: ${feedUrl}`);
  console.log(`MP3 URL check: HTTP ${mp3Check.status}`);
  console.log(`Feed URL check: HTTP ${feedCheck.status}`);
  if (!mp3Check.ok || !feedCheck.ok) throw new Error('Published URL verification failed');

  const seriesKey = inferSeriesKey(feed, slug, args.title);
  const producedDir = writeProducedEpisodeRecord({
    root,
    feed,
    seriesKey,
    slug,
    title: args.title,
    summary: args.summary,
    script,
    sourceScriptPath,
    copiedScriptPath,
    mp3Path,
    mp3Url,
    feedUrl,
    guid,
    mp3Bytes: mp3Body.length,
    publishedAt,
    duration: args.duration,
  });
  console.log(`Produced library: ${path.relative(root, producedDir).split(path.sep).join('/')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
