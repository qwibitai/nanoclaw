#!/usr/bin/env npx tsx
/**
 * Post to TikTok Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/social/post-tiktok.ts --title "Video caption" --video-url "https://example.com/video.mp4" [--privacy "PUBLIC_TO_EVERYONE"] [--disable-comments] [--dry-run]
 *
 * Uses TikTok Content Publishing API (PULL_FROM_URL mode)
 * Environment: TIKTOK_ACCESS_TOKEN, TIKTOK_OPEN_ID (optional)
 */

import https from 'https';

type PrivacyLevel = 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY';

interface TikTokArgs {
  title: string;
  videoUrl: string;
  privacy: PrivacyLevel;
  disableComments: boolean;
  dryRun: boolean;
}

function parseArgs(): TikTokArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--disable-comments') continue;
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  const dryRun = args.includes('--dry-run');
  const disableComments = args.includes('--disable-comments');

  if (!result.title || !result['video-url']) {
    console.error('Usage: post-tiktok --title "Video caption" --video-url "https://example.com/video.mp4" [--privacy "PUBLIC_TO_EVERYONE"] [--disable-comments] [--dry-run]');
    process.exit(1);
  }

  const privacy = (result.privacy || 'PUBLIC_TO_EVERYONE') as PrivacyLevel;
  const validPrivacy: PrivacyLevel[] = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];
  if (!validPrivacy.includes(privacy)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Invalid privacy level: ${privacy}. Must be one of: ${validPrivacy.join(', ')}`,
    }));
    process.exit(1);
  }

  return {
    title: result.title,
    videoUrl: result['video-url'],
    privacy,
    disableComments,
    dryRun,
  };
}

async function postToTikTok(args: TikTokArgs): Promise<void> {
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      platform: 'tiktok',
      title: args.title,
      video_url: args.videoUrl,
      privacy: args.privacy,
      disable_comments: args.disableComments,
      message: 'No post was published. Remove --dry-run to post for real.',
    }));
    return;
  }

  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;

  if (!accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing TikTok credentials. Set TIKTOK_ACCESS_TOKEN.',
    }));
    process.exit(1);
  }

  const body = JSON.stringify({
    post_info: {
      title: args.title,
      privacy_level: args.privacy,
      disable_duet: false,
      disable_comment: args.disableComments,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: args.videoUrl,
    },
  });

  const url = 'https://open.tiktokapis.com/v2/post/publish/';

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify({
            status: 'success',
            publish_id: parsed.data?.publish_id || parsed.publish_id,
            platform: 'tiktok',
            title: args.title.slice(0, 100),
          }));
          resolve();
        } else {
          console.error(JSON.stringify({
            status: 'error',
            error: data,
            statusCode: res.statusCode,
          }));
          process.exit(1);
        }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({ status: 'error', error: err.message }));
      process.exit(1);
    });

    req.write(body);
    req.end();
  });
}

postToTikTok(parseArgs());
