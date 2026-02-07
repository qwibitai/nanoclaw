/**
 * Parcel MCP Server for NanoClaw
 * Allows agents to view and add package deliveries via the Parcel app API.
 * API key passed via PARCEL_API_KEY environment variable.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PARCEL_API_BASE = 'https://api.parcel.app/external';

function log(message: string): void {
  console.error(`[deliveries-mcp] ${message}`);
}

const STATUS_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Label Created',
  2: 'In Transit',
  3: 'Out for Delivery',
  4: 'Delivered',
  5: 'Failed Attempt',
  6: 'Exception',
  7: 'Expired',
  8: 'Ready for Pickup',
};

function formatDelivery(d: {
  description: string;
  tracking_number: string;
  carrier_code: string;
  status_code: number;
  date_expected?: string;
  date_expected_end?: string;
  events?: Array<{
    event: string;
    date: string;
    location?: string;
    additional?: string;
  }>;
}): string {
  const status = STATUS_LABELS[d.status_code] ?? `Status ${d.status_code}`;
  const lines = [`- **${d.description}** (${status})`];
  lines.push(`  Tracking: ${d.tracking_number} (${d.carrier_code})`);

  if (d.date_expected) {
    lines.push(`  Expected: ${d.date_expected}${d.date_expected_end ? ` – ${d.date_expected_end}` : ''}`);
  }

  if (d.events && d.events.length > 0) {
    const latest = d.events[0];
    let eventLine = `  Latest: ${latest.event}`;
    if (latest.date) eventLine += ` (${latest.date})`;
    if (latest.location) eventLine += ` — ${latest.location}`;
    lines.push(eventLine);
  }

  return lines.join('\n');
}

export function createParcelMcp() {
  const apiKey = process.env.PARCEL_API_KEY;

  return createSdkMcpServer({
    name: 'deliveries',
    version: '1.0.0',
    tools: [
      tool(
        'get_deliveries',
        `Get tracked package deliveries.

filter_mode:
- "active": Only show deliveries that haven't been delivered yet
- "recent": Show recent deliveries including delivered ones (default)

Rate limit: 20 requests/hour.`,
        {
          filter_mode: z
            .enum(['active', 'recent'])
            .optional()
            .describe('Filter mode: "active" for in-transit only, "recent" for all recent (default)'),
        },
        async (args) => {
          if (!apiKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Delivery tracking not configured',
                },
              ],
              isError: true,
            };
          }

          try {
            const filterMode = args.filter_mode || 'recent';
            const url = `${PARCEL_API_BASE}/deliveries/?filter_mode=${filterMode}`;

            log(`Fetching deliveries (filter: ${filterMode})`);

            const response = await fetch(url, {
              headers: { 'api-key': apiKey },
            });

            if (!response.ok) {
              const text = await response.text();
              log(`Parcel API error: ${response.status} - ${text}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: `Delivery API error: ${response.status}`,
                  },
                ],
                isError: true,
              };
            }

            const data = await response.json();

            if (!data.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Delivery API error: ${data.error_message || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }

            const deliveries = data.deliveries || [];

            if (deliveries.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No ${filterMode} deliveries found.`,
                  },
                ],
              };
            }

            const formatted = deliveries.map(formatDelivery).join('\n\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Deliveries (${deliveries.length}, ${filterMode}):\n\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to fetch deliveries: ${errorMsg}`);
            return {
              content: [{ type: 'text', text: `Error: ${errorMsg}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'add_delivery',
        `Add a new package delivery to track.

The carrier_code identifies the shipping carrier.

Common codes for Portugal:
- "ctt" (CTT), "ctt-express" (CTT Expresso), "dpd-portugal" (DPD Portugal)
- "dhl" (DHL), "ups" (UPS), "fedex" (FedEx), "amazon" (Amazon Logistics)
- "pholder" (placeholder — when carrier is unknown)

Email-to-carrier mapping:
- *@cttexpresso.pt → "ctt-express", *@ctt.pt → "ctt"
- *@dhl.pt → "dhl", *@ups.com → "ups", *@fedex.com → "fedex"
- *@dpd.pt → "dpd-portugal", *@amazon.* → "amazon"

Rate limit: 20 additions/day.`,
        {
          tracking_number: z.string().describe('The package tracking number'),
          carrier_code: z
            .string()
            .describe('Carrier code (e.g., "ctt", "ctt-express", "dhl", "ups", "dpd-portugal", "amazon", "pholder")'),
          description: z.string().describe('Description of the delivery (e.g., "Encomenda Amazon")'),
          language: z
            .string()
            .optional()
            .describe('ISO 639-1 language code for tracking info (default: "en")'),
          send_push_confirmation: z
            .boolean()
            .optional()
            .describe('Send a push notification when added (default: false)'),
        },
        async (args) => {
          if (!apiKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Delivery tracking not configured',
                },
              ],
              isError: true,
            };
          }

          try {
            const url = `${PARCEL_API_BASE}/add-delivery/`;

            const body: Record<string, unknown> = {
              tracking_number: args.tracking_number,
              carrier_code: args.carrier_code,
              description: args.description,
            };

            if (args.language) {
              body.language = args.language;
            }

            if (args.send_push_confirmation) {
              body.send_push_confirmation = true;
            }

            log(`Adding delivery: ${args.description} (${args.tracking_number})`);

            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              const text = await response.text();
              log(`Parcel API error: ${response.status} - ${text}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: `Delivery API error: ${response.status}`,
                  },
                ],
                isError: true,
              };
            }

            const data = await response.json();

            if (!data.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Failed to add delivery: ${data.error_message || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }

            log(`Delivery added: ${args.description}`);

            return {
              content: [
                {
                  type: 'text',
                  text: `Delivery added: "${args.description}" (${args.tracking_number} via ${args.carrier_code}). It may take a moment for tracking data to appear.`,
                },
              ],
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add delivery: ${errorMsg}`);
            return {
              content: [{ type: 'text', text: `Error: ${errorMsg}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
