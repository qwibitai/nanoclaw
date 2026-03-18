/**
 * Stub Anthropic API server for E2E testing.
 *
 * Replaces the credential proxy — containers point ANTHROPIC_BASE_URL here.
 * Returns canned SSE streaming responses matching the Anthropic Messages API
 * format. No real API calls, no credentials needed.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

export interface StubServerOptions {
  /** Response text the stub agent will "say". Default: "Hello from E2E test" */
  responseText?: string;
  /** Model name in responses. Default: "claude-haiku-4-5-20251001" */
  model?: string;
}

/**
 * Start a stub Anthropic API server on a random available port.
 * Returns the server and the port it's listening on.
 */
export async function startStubServer(
  options: StubServerOptions = {},
): Promise<{ server: Server; port: number }> {
  const responseText = options.responseText ?? 'Hello from E2E test';
  const model = options.model ?? 'claude-haiku-4-5-20251001';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        handleMessages(res, responseText, model);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function handleMessages(
  res: ServerResponse,
  text: string,
  model: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const msgId = `msg_e2e_${Date.now()}`;

  const events = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: text.split(' ').length },
      },
    },
    {
      event: 'message_stop',
      data: { type: 'message_stop' },
    },
  ];

  for (const { event, data } of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  res.end();
}
