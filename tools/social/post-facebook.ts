#!/usr/bin/env npx tsx
/**
 * Post to Facebook Page Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/social/post-facebook.ts --message "post content" [--link "url"] [--image "url"] [--place-id "ID"] [--dry-run]
 *   npx tsx tools/social/post-facebook.ts --message "post content" --source /tmp/photo.jpg [--place-id "ID"] [--dry-run]
 *
 * --image: Attach a photo by URL (Facebook fetches it)
 * --source: Upload a local file (image or video) via multipart/form-data
 * --place-id: Tag a Facebook Place (location) on the post
 *
 * Uses Facebook Graph API v21.0
 * Environment: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

interface FacebookArgs {
  message: string;
  link?: string;
  image?: string;
  source?: string;
  placeId?: string;
  dryRun?: boolean;
}

function parseArgs(): FacebookArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  const dryRun = args.includes('--dry-run');

  if (!result.message) {
    console.error('Usage: post-facebook --message "post content" [--link "url"] [--image "url"] [--source "/path/to/file"] [--place-id "ID"] [--dry-run]');
    process.exit(1);
  }

  if (result.image && result.source) {
    console.error(JSON.stringify({
      status: 'error',
      error: '--image and --source are mutually exclusive. Use --image for URLs, --source for local files.',
    }));
    process.exit(1);
  }

  return {
    message: result.message,
    link: result.link,
    image: result.image,
    source: result.source,
    placeId: result['place-id'],
    dryRun,
  };
}

function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.mov', '.avi', '.wmv', '.flv', '.mkv', '.webm'].includes(ext);
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Post using URL-encoded form data (text posts, link posts, photo-by-URL)
 */
async function postUrlEncoded(
  endpoint: string,
  params: URLSearchParams,
): Promise<void> {
  const postData = params.toString();
  const url = `https://graph.facebook.com/v21.0${endpoint}`;

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify({
            status: 'success',
            post_id: parsed.id || parsed.post_id,
          }));
          resolve();
        } else {
          console.error(JSON.stringify({
            status: 'error',
            statusCode: res.statusCode,
            error: data,
          }));
          process.exit(1);
        }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({ status: 'error', error: err.message }));
      process.exit(1);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Post using multipart/form-data (local file upload)
 */
async function postMultipart(
  endpoint: string,
  fields: Record<string, string>,
  filePath: string,
  fileFieldName: string,
): Promise<void> {
  const boundary = '----NanoClawBoundary' + Date.now().toString(36);
  const fileName = path.basename(filePath);
  const mimeType = getMimeType(filePath);
  const fileData = fs.readFileSync(filePath);

  // Build multipart body
  const parts: Buffer[] = [];

  // Add text fields
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  // Add file field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  const url = `https://graph.facebook.com/v21.0${endpoint}`;

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify({
            status: 'success',
            post_id: parsed.id || parsed.post_id,
            file: fileName,
          }));
          resolve();
        } else {
          console.error(JSON.stringify({
            status: 'error',
            statusCode: res.statusCode,
            error: data,
            file: fileName,
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

async function postToFacebook(args: FacebookArgs): Promise<void> {
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      platform: 'facebook',
      message: args.message,
      link: args.link || null,
      image: args.image || null,
      source: args.source || null,
      place_id: args.placeId || null,
      char_count: args.message.length,
      message_note: 'No post was published. Remove --dry-run to post for real.',
    }));
    return;
  }

  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing Facebook credentials. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN.',
    }));
    process.exit(1);
  }

  // ── Local file upload (multipart) ──
  if (args.source) {
    if (!fs.existsSync(args.source)) {
      console.error(JSON.stringify({
        status: 'error',
        error: `Source file not found: ${args.source}`,
      }));
      process.exit(1);
    }

    const isVideo = isVideoFile(args.source);
    const endpoint = isVideo
      ? `/${pageId}/videos`
      : `/${pageId}/photos`;

    const fields: Record<string, string> = {
      access_token: accessToken,
    };

    if (isVideo) {
      fields.description = args.message;
    } else {
      fields.caption = args.message;
    }

    if (args.placeId) {
      fields.place = args.placeId;
    }

    await postMultipart(endpoint, fields, args.source, 'source');
    return;
  }

  // ── URL-based photo post ──
  if (args.image) {
    const params = new URLSearchParams();
    params.set('access_token', accessToken);
    params.set('caption', args.message);
    params.set('url', args.image);
    if (args.placeId) params.set('place', args.placeId);

    await postUrlEncoded(`/${pageId}/photos`, params);
    return;
  }

  // ── Text/link post ──
  const params = new URLSearchParams();
  params.set('access_token', accessToken);
  params.set('message', args.message);
  if (args.link) params.set('link', args.link);
  if (args.placeId) params.set('place', args.placeId);

  await postUrlEncoded(`/${pageId}/feed`, params);
}

postToFacebook(parseArgs());
