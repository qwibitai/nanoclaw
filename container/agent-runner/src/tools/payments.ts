import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { IPC_DIR } from '../tool-context.js';

const X402_REQUESTS_DIR = path.join(IPC_DIR, 'x402-requests');
const X402_RESPONSES_DIR = path.join(IPC_DIR, 'x402-responses');

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'x402_fetch',
    'Make an HTTP request that can automatically pay x402 paywalls using USDC on Base. The payment is handled securely by the host — you never touch the wallet. Use this when accessing paid APIs or x402-enabled endpoints.',
    {
      url: z.string().describe('The URL to fetch'),
      method: z.string().default('GET').describe('HTTP method (GET, POST, etc.)'),
      headers: z.record(z.string(), z.string()).optional().describe('Optional HTTP headers'),
      body: z.string().optional().describe('Optional request body'),
      max_price_usd: z.number().default(1.0).describe('Maximum USDC you are willing to pay for this request. Default $1.'),
    },
    async (args) => {
      const spendCheck = ctx.checkSpendLimit(args.max_price_usd);
      if (!spendCheck.allowed) {
        return { content: [{ type: 'text' as const, text: spendCheck.message }], isError: true };
      }

      fs.mkdirSync(X402_REQUESTS_DIR, { recursive: true });
      fs.mkdirSync(X402_RESPONSES_DIR, { recursive: true });

      const requestId = `x402-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestPath = path.join(X402_REQUESTS_DIR, `${requestId}.json`);

      fs.writeFileSync(requestPath, JSON.stringify({
        id: requestId,
        url: args.url,
        method: args.method,
        headers: args.headers || {},
        body: args.body || null,
        max_price_usd: args.max_price_usd,
        timestamp: new Date().toISOString(),
      }));

      const responsePath = path.join(X402_RESPONSES_DIR, `${requestId}.json`);
      const timeout = 60000;
      const interval = 200;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responsePath)) {
          try {
            const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
            try { fs.unlinkSync(responsePath); } catch { /* ignore */ }

            if (response.error) {
              return { content: [{ type: 'text' as const, text: `x402 error: ${response.error}` }], isError: true };
            }

            let summary = `**Status:** ${response.status}\n`;
            if (response.paid) {
              summary += `**Paid:** $${response.amount_usd} USDC on Base\n`;
              if (response.tx_hash) summary += `**Tx:** ${response.tx_hash}\n`;
            }
            summary += `\n${response.body || '(empty response)'}`;

            return { content: [{ type: 'text' as const, text: summary }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to parse x402 response: ${err}` }], isError: true };
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      try { fs.unlinkSync(requestPath); } catch { /* ignore */ }
      return { content: [{ type: 'text' as const, text: 'x402 request timed out (60s). The host may not be processing x402 requests.' }], isError: true };
    },
  );
}
