/**
 * Grok Web Search via xAI Responses API
 *
 * Uses xAI's native web_search tool through the /v1/responses endpoint.
 * Grok decides server-side when to search, returns results with inline citations.
 */

interface OutputText {
  type: 'output_text';
  text: string;
  annotations?: Array<{
    type: string;
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface OutputMessage {
  type: 'message';
  content: Array<OutputText | { type: string }>;
}

interface ResponsesApiResponse {
  output_text?: string;
  output?: Array<OutputMessage | { type: string }>;
}

/**
 * Extract text from xAI Responses API output.
 * Handles both the top-level output_text convenience field
 * and the nested output[].content[].output_text format.
 */
function extractContent(data: ResponsesApiResponse): {
  text: string;
  citations: Array<{ url: string; title: string }>;
} {
  const citations: Array<{ url: string; title: string }> = [];

  // Try top-level convenience field first
  if (data.output_text) {
    return { text: data.output_text, citations };
  }

  // Parse nested output array
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && 'content' in item) {
        const msg = item as OutputMessage;
        for (const block of msg.content) {
          if (block.type === 'output_text') {
            const textBlock = block as OutputText;
            // Collect url_citation annotations
            if (textBlock.annotations) {
              for (const ann of textBlock.annotations) {
                if (ann.type === 'url_citation' && ann.url) {
                  citations.push({
                    url: ann.url,
                    title: ann.title || 'Source',
                  });
                }
              }
            }
            if (textBlock.text) {
              return { text: textBlock.text, citations };
            }
          }
        }
      }
    }
  }

  return { text: '', citations };
}

export async function grokWebSearch(
  query: string,
  apiKey: string,
): Promise<{ text: string; isError: boolean }> {
  try {
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        input: [
          {
            role: 'user',
            content: query,
          },
        ],
        tools: [{ type: 'web_search' }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        text: `Web search failed (${response.status}): ${errorText}`,
        isError: true,
      };
    }

    const data = (await response.json()) as ResponsesApiResponse;
    const { text, citations } = extractContent(data);

    if (!text) {
      return { text: 'No results returned from web search.', isError: true };
    }

    // Append deduplicated sources if citations exist
    let result = text;
    if (citations.length > 0) {
      const seen = new Set<string>();
      const unique = citations.filter((c) => {
        if (seen.has(c.url)) return false;
        seen.add(c.url);
        return true;
      });
      result += '\n\n---\nSources:\n';
      for (const c of unique) {
        result += `- [${c.title}](${c.url})\n`;
      }
    }

    return { text: result, isError: false };
  } catch (err) {
    return {
      text: `Web search error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
