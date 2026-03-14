#!/usr/bin/env npx tsx
/**
 * Post Tweet Tool for NanoClaw
 * Usage: npx tsx tools/social/post-tweet.ts --text "tweet content" [--reply-to "tweet_id"] [--dry-run]
 *
 * Uses X API v2 (OAuth 1.0a User Context)
 * Environment: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 */

import crypto from 'crypto';
import https from 'https';

interface TweetArgs {
  text: string;
  replyTo?: string;
  dryRun?: boolean;
}

function parseArgs(): TweetArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2).replace(/-/g, '_')] = args[++i];
    }
  }

  const dryRun = args.includes('--dry-run');

  if (!result.text) {
    console.error('Usage: post-tweet --text "tweet content" [--reply-to "tweet_id"] [--dry-run]');
    process.exit(1);
  }

  return { text: result.text, replyTo: result.reply_to, dryRun };
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  const baseString = `${method}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;

  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildAuthHeader(url: string, method: string): string {
  const apiKey = process.env.X_API_KEY!;
  const apiSecret = process.env.X_API_SECRET!;
  const accessToken = process.env.X_ACCESS_TOKEN!;
  const accessSecret = process.env.X_ACCESS_SECRET!;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  oauthParams.oauth_signature = generateOAuthSignature(
    method,
    url,
    oauthParams,
    apiSecret,
    accessSecret,
  );

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

async function postTweet(args: TweetArgs): Promise<void> {
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      platform: 'twitter',
      text: args.text,
      reply_to: args.replyTo || null,
      char_count: args.text.length,
      message: 'No tweet was posted. Remove --dry-run to post for real.',
    }));
    return;
  }

  const url = 'https://api.twitter.com/2/tweets';

  if (!process.env.X_API_KEY || !process.env.X_API_SECRET || !process.env.X_ACCESS_TOKEN || !process.env.X_ACCESS_SECRET) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing X API credentials. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.',
    }));
    process.exit(1);
  }

  const body: Record<string, unknown> = { text: args.text };
  if (args.replyTo) {
    body.reply = { in_reply_to_tweet_id: args.replyTo };
  }

  const postData = JSON.stringify(body);
  const authHeader = buildAuthHeader(url, 'POST');

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201) {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify({
            status: 'success',
            tweet_id: parsed.data?.id,
            text: args.text.slice(0, 100),
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

postTweet(parseArgs());
