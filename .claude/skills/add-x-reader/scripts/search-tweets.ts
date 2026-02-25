/**
 * X API v2 - Search recent tweets by query
 *
 * Input (stdin JSON): { query: string, maxResults?: number, bearerToken: string }
 * Output (stdout JSON): { success: boolean, message: string, data?: object }
 */

import {
  readInput,
  writeResult,
  xApiGet,
  formatTweets,
  tweetQueryParams,
  type SearchResponse,
} from './lib/api.js';

interface Input {
  query: string;
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

    if (!input.query) {
      writeResult({ success: false, message: 'Missing search query.' });
      return;
    }

    const maxResults = input.maxResults || 10;
    const params = {
      query: input.query,
      ...tweetQueryParams(maxResults),
    };

    const response = await xApiGet<SearchResponse>('/tweets/search/recent', params, input.bearerToken);

    if (!response.data || response.data.length === 0) {
      writeResult({
        success: true,
        message: `No tweets found for query: "${input.query}"`,
        data: { resultCount: 0 },
      });
      return;
    }

    const formatted = formatTweets(response.data, response.includes?.users);
    const count = response.meta?.result_count || response.data.length;

    writeResult({
      success: true,
      message: `Found ${count} tweets for "${input.query}":\n\n${formatted}`,
      data: {
        resultCount: count,
        tweets: response.data,
        users: response.includes?.users,
      },
    });
  } catch (err) {
    writeResult({
      success: false,
      message: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

main();
