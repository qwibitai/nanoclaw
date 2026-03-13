/**
 * X API v2 - Get recent tweets from a specific user
 *
 * Input (stdin JSON): { username: string, maxResults?: number, bearerToken: string }
 * Output (stdout JSON): { success: boolean, message: string, data?: object }
 *
 * Two-step process:
 * 1. Resolve @username to numeric user ID
 * 2. Fetch user's recent tweets
 */

import {
  readInput,
  writeResult,
  xApiGet,
  formatTweets,
  tweetQueryParams,
  type UserLookupResponse,
  type TimelineResponse,
} from './lib/api.js';

interface Input {
  username: string;
  maxResults?: number;
  bearerToken: string;
}

async function main() {
  try {
    const input = await readInput<Input>();

    if (!input.bearerToken) {
      writeResult({ success: false, message: 'Missing X_BEARER_TOKEN. Add it to your .env file.' });
      return;
    }

    if (!input.username) {
      writeResult({ success: false, message: 'Missing username.' });
      return;
    }

    // Strip leading @ if present
    const username = input.username.replace(/^@/, '');

    // Step 1: Resolve username to user ID
    const userResponse = await xApiGet<UserLookupResponse>(
      `/users/by/username/${encodeURIComponent(username)}`,
      { 'user.fields': 'name,username,public_metrics' },
      input.bearerToken,
    );

    if (!userResponse.data) {
      const errorDetail = userResponse.errors?.[0]?.detail || 'User not found';
      writeResult({ success: false, message: `Could not find user @${username}: ${errorDetail}` });
      return;
    }

    const userId = userResponse.data.id;
    const displayName = userResponse.data.name;

    // Step 2: Fetch user's recent tweets
    const maxResults = input.maxResults || 10;
    const timelineResponse = await xApiGet<TimelineResponse>(
      `/users/${userId}/tweets`,
      tweetQueryParams(maxResults),
      input.bearerToken,
    );

    if (!timelineResponse.data || timelineResponse.data.length === 0) {
      writeResult({
        success: true,
        message: `No recent tweets found from @${username} (${displayName}).`,
        data: { resultCount: 0, user: userResponse.data },
      });
      return;
    }

    // Add author info to each tweet for formatting
    const user = { id: userId, name: displayName, username };
    const formatted = formatTweets(
      timelineResponse.data,
      [user],
    );
    const count = timelineResponse.meta?.result_count || timelineResponse.data.length;

    writeResult({
      success: true,
      message: `${count} recent tweets from @${username} (${displayName}):\n\n${formatted}`,
      data: {
        resultCount: count,
        user: userResponse.data,
        tweets: timelineResponse.data,
      },
    });
  } catch (err) {
    writeResult({
      success: false,
      message: `Failed to get timeline: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

main();
