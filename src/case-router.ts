/**
 * Case Router — routes incoming messages to the correct case using Haiku.
 * Only activates when a group has 2+ active cases.
 */
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { Case } from './cases.js';

export interface RouteResult {
  caseId: string | null;
  caseName: string | null;
  confidence: number;
  suggestNew: boolean;
  reason?: string;
}

/**
 * Route a message to the appropriate case using Haiku.
 * Returns the matched case ID, or null if no match / should create new.
 */
export async function routeMessageToCase(
  messageText: string,
  senderName: string,
  activeCases: Case[],
): Promise<RouteResult> {
  if (activeCases.length === 0) {
    return { caseId: null, caseName: null, confidence: 0, suggestNew: true };
  }

  if (activeCases.length === 1) {
    // Only one case — route there by default unless clearly unrelated
    return {
      caseId: activeCases[0].id,
      caseName: activeCases[0].name,
      confidence: 0.8,
      suggestNew: false,
    };
  }

  // 2+ cases: call Haiku for classification
  const caseSummaries = activeCases
    .map((c, i) => {
      const age = c.last_activity_at
        ? timeSince(new Date(c.last_activity_at))
        : 'no activity';
      return `${i + 1}. [${c.name}] (${c.type}, ${c.status}) — ${c.description}. Last: "${(c.last_message || 'none').slice(0, 100)}" (${age})`;
    })
    .join('\n');

  const prompt = `You are a message router. Given an incoming message and a list of active cases, determine which case this message belongs to.

Active cases:
${caseSummaries}

Incoming message from ${senderName}: "${messageText.slice(0, 500)}"

BIAS: Prefer the most recently active case when ambiguous.

Respond with JSON only (no markdown):
{"case_number": <1-based index or 0 if none match>, "confidence": <0.0-1.0>, "reason": "<brief reason>"}`;

  try {
    const response = await callHaiku(prompt);
    const parsed = JSON.parse(response);

    if (
      parsed.case_number > 0 &&
      parsed.case_number <= activeCases.length &&
      parsed.confidence >= 0.4
    ) {
      const matched = activeCases[parsed.case_number - 1];
      return {
        caseId: matched.id,
        caseName: matched.name,
        confidence: parsed.confidence,
        suggestNew: false,
        reason: parsed.reason,
      };
    }

    return {
      caseId: null,
      caseName: null,
      confidence: parsed.confidence || 0,
      suggestNew: true,
      reason: parsed.reason,
    };
  } catch (err) {
    logger.error({ err }, 'Haiku routing failed, falling back to most recent');
    // Fallback: route to most recently active case
    const sorted = [...activeCases].sort(
      (a, b) =>
        new Date(b.last_activity_at || 0).getTime() -
        new Date(a.last_activity_at || 0).getTime(),
    );
    return {
      caseId: sorted[0].id,
      caseName: sorted[0].name,
      confidence: 0.5,
      suggestNew: false,
      reason: 'Haiku fallback: routed to most recent case',
    };
  }
}

// ---------------------------------------------------------------------------
// Haiku API call (direct, bypassing credential proxy)
// ---------------------------------------------------------------------------

async function callHaiku(prompt: string): Promise<string> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]);

  const apiKey = secrets.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured — cannot route messages via Haiku',
    );
  }

  const baseUrl = new URL(
    secrets.ANTHROPIC_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com',
  );

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const isHttps = baseUrl.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    const req = makeRequest(
      {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.content?.[0]?.text) {
              resolve(data.content[0].text.trim());
            } else {
              reject(new Error(`Unexpected Haiku response: ${JSON.stringify(data)}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Haiku request timeout'));
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function timeSince(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
