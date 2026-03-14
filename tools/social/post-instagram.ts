#!/usr/bin/env npx tsx
/**
 * Post to Instagram Business Account Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/social/post-instagram.ts --caption "post content" --image-url "url" [--location-id "ID"] [--dry-run]
 *   npx tsx tools/social/post-instagram.ts --caption "post content" --video-url "url" [--location-id "ID"] [--dry-run]
 *
 * --image-url: Public URL of image to post (photo post)
 * --video-url: Public URL of video to post (creates a Reel)
 * --location-id: Instagram location ID for geo-tagging
 * --source: Not supported — Instagram API requires public URLs
 *
 * Uses Instagram Graph API via Facebook Graph API v21.0
 * Environment: IG_ACCOUNT_ID, IG_ACCESS_TOKEN (falls back to FB_PAGE_ACCESS_TOKEN)
 */

import https from 'https';

interface InstagramArgs {
  caption: string;
  imageUrl?: string;
  videoUrl?: string;
  source?: string;
  locationId?: string;
  dryRun?: boolean;
}

function parseArgs(): InstagramArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg !== '--dry-run' && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  const dryRun = args.includes('--dry-run');

  if (!result.caption) {
    console.error('Usage: post-instagram --caption "post content" --image-url "url" [--video-url "url"] [--location-id "ID"] [--dry-run]');
    process.exit(1);
  }

  if (result.source) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Instagram API requires public image/video URLs. Use --image-url or --video-url instead, or upload the file to a public location first.',
    }));
    process.exit(1);
  }

  if (!result['image-url'] && !result['video-url'] && !dryRun) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Instagram feed posts require media. Provide --image-url for photo posts or --video-url for Reels. Text-only feed posts are not supported by the Instagram API.',
    }));
    process.exit(1);
  }

  if (result['image-url'] && result['video-url']) {
    console.error(JSON.stringify({
      status: 'error',
      error: '--image-url and --video-url are mutually exclusive. Use one or the other.',
    }));
    process.exit(1);
  }

  return {
    caption: result.caption,
    imageUrl: result['image-url'],
    videoUrl: result['video-url'],
    source: result.source,
    locationId: result['location-id'],
    dryRun,
  };
}

/**
 * Make a Graph API request and return parsed JSON response
 */
function graphRequest(
  method: string,
  urlPath: string,
  params?: URLSearchParams,
): Promise<{ statusCode: number; body: any }> {
  const url = `https://graph.facebook.com/v21.0${urlPath}`;
  const postData = params ? params.toString() : '';

  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      method,
      headers: method === 'POST' ? {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      } : undefined,
    };

    const fullUrl = method === 'GET' && params
      ? `${url}?${params.toString()}`
      : url;

    const req = https.request(fullUrl, options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode || 500, body: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode || 500, body: data });
        }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({ status: 'error', error: err.message }));
      process.exit(1);
    });

    if (method === 'POST' && postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Poll container status until FINISHED or error
 */
async function pollContainerStatus(
  containerId: string,
  accessToken: string,
  maxAttempts: number = 30,
  intervalMs: number = 5000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const params = new URLSearchParams();
    params.set('fields', 'status_code');
    params.set('access_token', accessToken);

    const { body } = await graphRequest('GET', `/${containerId}`, params);
    const status = body.status_code;

    if (status === 'FINISHED') {
      return;
    }

    if (status === 'ERROR') {
      console.error(JSON.stringify({
        status: 'error',
        error: `Media container processing failed. Status: ERROR`,
        container_id: containerId,
      }));
      process.exit(1);
    }

    if (status === 'EXPIRED') {
      console.error(JSON.stringify({
        status: 'error',
        error: 'Media container expired before publishing.',
        container_id: containerId,
      }));
      process.exit(1);
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.error(JSON.stringify({
    status: 'error',
    error: `Media container did not finish processing after ${maxAttempts} attempts.`,
    container_id: containerId,
  }));
  process.exit(1);
}

async function postToInstagram(args: InstagramArgs): Promise<void> {
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      platform: 'instagram',
      caption: args.caption,
      image_url: args.imageUrl || null,
      video_url: args.videoUrl || null,
      location_id: args.locationId || null,
      char_count: args.caption.length,
      message: 'No post was published. Remove --dry-run to post for real.',
    }));
    return;
  }

  const igAccountId = process.env.IG_ACCOUNT_ID;
  const accessToken = process.env.IG_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;

  if (!igAccountId || !accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing Instagram credentials. Set IG_ACCOUNT_ID and IG_ACCESS_TOKEN (or FB_PAGE_ACCESS_TOKEN).',
    }));
    process.exit(1);
  }

  // ── Video/Reel post (three-step) ──
  if (args.videoUrl) {
    // Step 1: Create media container
    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('video_url', args.videoUrl);
    containerParams.set('caption', args.caption);
    containerParams.set('media_type', 'REELS');
    if (args.locationId) containerParams.set('location_id', args.locationId);

    const containerRes = await graphRequest('POST', `/${igAccountId}/media`, containerParams);

    if (containerRes.statusCode !== 200) {
      console.error(JSON.stringify({
        status: 'error',
        statusCode: containerRes.statusCode,
        error: containerRes.body,
      }));
      process.exit(1);
    }

    const containerId = containerRes.body.id;

    // Step 2: Poll until processing is finished
    await pollContainerStatus(containerId, accessToken);

    // Step 3: Publish
    const publishParams = new URLSearchParams();
    publishParams.set('access_token', accessToken);
    publishParams.set('creation_id', containerId);

    const publishRes = await graphRequest('POST', `/${igAccountId}/media_publish`, publishParams);

    if (publishRes.statusCode === 200) {
      console.log(JSON.stringify({
        status: 'success',
        post_id: publishRes.body.id,
        platform: 'instagram',
        caption: args.caption.substring(0, 100),
      }));
    } else {
      console.error(JSON.stringify({
        status: 'error',
        statusCode: publishRes.statusCode,
        error: publishRes.body,
      }));
      process.exit(1);
    }
    return;
  }

  // ── Photo post (two-step) ──
  if (args.imageUrl) {
    // Step 1: Create media container
    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('image_url', args.imageUrl);
    containerParams.set('caption', args.caption);
    if (args.locationId) containerParams.set('location_id', args.locationId);

    const containerRes = await graphRequest('POST', `/${igAccountId}/media`, containerParams);

    if (containerRes.statusCode !== 200) {
      console.error(JSON.stringify({
        status: 'error',
        statusCode: containerRes.statusCode,
        error: containerRes.body,
      }));
      process.exit(1);
    }

    const containerId = containerRes.body.id;

    // Step 2: Publish
    const publishParams = new URLSearchParams();
    publishParams.set('access_token', accessToken);
    publishParams.set('creation_id', containerId);

    const publishRes = await graphRequest('POST', `/${igAccountId}/media_publish`, publishParams);

    if (publishRes.statusCode === 200) {
      console.log(JSON.stringify({
        status: 'success',
        post_id: publishRes.body.id,
        platform: 'instagram',
        caption: args.caption.substring(0, 100),
      }));
    } else {
      console.error(JSON.stringify({
        status: 'error',
        statusCode: publishRes.statusCode,
        error: publishRes.body,
      }));
      process.exit(1);
    }
    return;
  }

  // Should not reach here due to parseArgs validation
  console.error(JSON.stringify({
    status: 'error',
    error: 'No media provided. Instagram feed posts require --image-url or --video-url.',
  }));
  process.exit(1);
}

postToInstagram(parseArgs());
