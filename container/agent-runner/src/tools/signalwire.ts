import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';
import { swCurl } from '../tool-context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const SW_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID || '';
  const SW_API_TOKEN = process.env.SIGNALWIRE_API_TOKEN || '';
  const SW_PHONE = process.env.SIGNALWIRE_PHONE_NUMBER || '';

  server.tool(
    'send_sms',
    `Send an SMS text message from your phone number (${SW_PHONE || 'not configured'}). Use this to reach people directly — follow-ups, notifications, outreach. Keep messages concise and professional.`,
    {
      to: z.string().describe('Phone number to send to (E.164 format, e.g. "+14155551234")'),
      body: z.string().describe('The message text (max 1600 chars)'),
    },
    async (args) => {
      if (!SW_PROJECT_ID || !SW_API_TOKEN) {
        return { content: [{ type: 'text' as const, text: 'SignalWire not configured. Ask Brandon to add credentials.' }], isError: true };
      }
      const smsLimit = ctx.checkRateLimit('send_sms');
      if (!smsLimit.allowed) {
        return { content: [{ type: 'text' as const, text: smsLimit.message }], isError: true };
      }
      const data = `From=${encodeURIComponent(SW_PHONE)}&To=${encodeURIComponent(args.to)}&Body=${encodeURIComponent(args.body)}`;
      const result = swCurl('/Messages.json', 'POST', data);
      try {
        const parsed = JSON.parse(result);
        if (parsed.sid) {
          return { content: [{ type: 'text' as const, text: `SMS sent to ${args.to} (SID: ${parsed.sid}, status: ${parsed.status})` }] };
        }
        return { content: [{ type: 'text' as const, text: `SMS error: ${JSON.stringify(parsed)}` }], isError: true };
      } catch {
        return { content: [{ type: 'text' as const, text: `SMS response: ${result}` }] };
      }
    },
  );

  server.tool(
    'check_messages',
    'Check recent SMS messages (sent and received) on your phone number. Use this to see if anyone has texted you, or check delivery status of messages you sent.',
    {
      direction: z.enum(['inbound', 'outbound', 'all']).default('all').describe('Filter by message direction'),
      limit: z.number().default(10).describe('How many messages to return (max 50)'),
    },
    async (args) => {
      if (!SW_PROJECT_ID || !SW_API_TOKEN) {
        return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
      }
      let endpoint = `/Messages.json?PageSize=${Math.min(args.limit, 50)}`;
      if (args.direction === 'inbound') {
        endpoint += `&To=${encodeURIComponent(SW_PHONE)}`;
      } else if (args.direction === 'outbound') {
        endpoint += `&From=${encodeURIComponent(SW_PHONE)}`;
      }
      const result = swCurl(endpoint);
      try {
        const parsed = JSON.parse(result);
        if (parsed.messages && parsed.messages.length > 0) {
          const msgs = parsed.messages.map((m: { date_sent: string; from: string; to: string; body: string; status: string; direction: string }) =>
            `[${m.date_sent}] ${m.direction === 'inbound' ? m.from + ' -> you' : 'you -> ' + m.to}: ${m.body} (${m.status})`
          ).join('\n');
          return { content: [{ type: 'text' as const, text: `## Recent SMS (${parsed.messages.length})\n\n${msgs}` }] };
        }
        return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
      } catch {
        return { content: [{ type: 'text' as const, text: `Response: ${result.slice(0, 500)}` }] };
      }
    },
  );

  server.tool(
    'make_call',
    `Make a phone call from your number (${SW_PHONE || 'not configured'}). The call will play a text-to-speech message to the recipient. Use for important outreach where SMS is not enough.`,
    {
      to: z.string().describe('Phone number to call (E.164 format, e.g. "+14155551234")'),
      message: z.string().describe('Text-to-speech message the recipient will hear when they answer'),
      voice: z.enum(['man', 'woman', 'alice']).default('man').describe('Voice for text-to-speech'),
    },
    async (args) => {
      if (!SW_PROJECT_ID || !SW_API_TOKEN) {
        return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
      }
      const callLimit = ctx.checkRateLimit('make_call');
      if (!callLimit.allowed) {
        return { content: [{ type: 'text' as const, text: callLimit.message }], isError: true };
      }
      const twiml = `<Response><Say voice="${args.voice}">${args.message.replace(/[&<>"']/g, '')}</Say></Response>`;
      const data = `From=${encodeURIComponent(SW_PHONE)}&To=${encodeURIComponent(args.to)}&Twiml=${encodeURIComponent(twiml)}`;
      const result = swCurl('/Calls.json', 'POST', data);
      try {
        const parsed = JSON.parse(result);
        if (parsed.sid) {
          return { content: [{ type: 'text' as const, text: `Call initiated to ${args.to} (SID: ${parsed.sid}, status: ${parsed.status})` }] };
        }
        return { content: [{ type: 'text' as const, text: `Call error: ${JSON.stringify(parsed)}` }], isError: true };
      } catch {
        return { content: [{ type: 'text' as const, text: `Response: ${result}` }] };
      }
    },
  );

  server.tool(
    'check_calls',
    'Check recent phone call logs. See who called you and calls you made.',
    {
      limit: z.number().default(10).describe('How many call records to return (max 50)'),
    },
    async (args) => {
      if (!SW_PROJECT_ID || !SW_API_TOKEN) {
        return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
      }
      const endpoint = `/Calls.json?PageSize=${Math.min(args.limit, 50)}`;
      const result = swCurl(endpoint);
      try {
        const parsed = JSON.parse(result);
        if (parsed.calls && parsed.calls.length > 0) {
          const calls = parsed.calls.map((c: { date_created: string; from: string; to: string; status: string; duration: string; direction: string }) =>
            `[${c.date_created}] ${c.direction}: ${c.from} -> ${c.to} (${c.status}, ${c.duration}s)`
          ).join('\n');
          return { content: [{ type: 'text' as const, text: `## Recent Calls (${parsed.calls.length})\n\n${calls}` }] };
        }
        return { content: [{ type: 'text' as const, text: 'No call records found.' }] };
      } catch {
        return { content: [{ type: 'text' as const, text: `Response: ${result.slice(0, 500)}` }] };
      }
    },
  );
}
