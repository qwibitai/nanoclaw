/**
 * Response Quality Interceptor
 *
 * Think of this like a copy editor between Atlas and the CEO.
 * Atlas writes a response, the editor reviews it for quality
 * (plain language, no jargon without analogies, decisions clearly
 * marked as confirmed vs open). If it fails, the editor sends it
 * back for one rewrite. Then it goes out regardless.
 *
 * Only runs for CEO-facing responses (not scheduled tasks).
 * Uses Haiku for fast, cheap quality evaluation.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';

export interface QualityCheckResult {
  pass: boolean;
  violations: QualityViolation[];
  score: number; // 0-100, higher = better quality
}

export interface QualityViolation {
  rule: string;
  severity: 'critical' | 'warning';
  description: string;
}

export interface InterceptionLog {
  timestamp: string;
  entity: string;
  originalScore: number;
  retried: boolean;
  finalScore: number;
  violations: string[];
  responseLength: number;
}

const QUALITY_CHECK_PROMPT = `You are a strict quality checker for an AI assistant talking to a CEO who is NOT a developer. The CEO runs a property management and landscaping business. Technical explanations MUST start with plain-language analogies.

NON-NEGOTIABLE RULE: Every technical term or concept MUST be preceded by a plain-language analogy or "think of it like..." sentence. This applies EVEN WHEN the CEO asks a technical question. Asking about "how X works" does NOT mean they want raw jargon — they want the explanation in plain language FIRST, then optional technical detail.

FAIL EXAMPLES (should score < 60):
- "interceptMessage() filters for assistant type with tool_use blocks" → NO analogy before the jargon
- "Appends one JSON line to the audit pipeline" → What is JSON? What is a pipeline? Explain first.
- "The credential proxy swaps tokens via OAuth refresh_token grant" → CEO doesn't know what any of this means

PASS EXAMPLES (should score 85+):
- "Think of it like a security camera — it watches every action but never stops anything. In code terms, that's an audit interceptor." → Analogy FIRST, then term.
- "Like a copy editor checking your work before it goes to print — that's what the quality checker does." → Plain language leads.

Check the response below. Return ONLY raw JSON, no markdown fences.

{"score": 0-100, "violations": [
  {"rule": "layman_first", "severity": "critical", "description": "quote the specific jargon that lacks a preceding analogy"},
  {"rule": "non_answer", "severity": "critical", "description": "quote the deflection, pointer, or meta-commentary instead of an answer"},
  {"rule": "decision_confirmation", "severity": "critical", "description": "what decision was presented as final without CEO approval"},
  {"rule": "assumptions", "severity": "warning", "description": "what business assumption was unstated"}
]}

Scoring:
- 85+ = pass. Every technical concept has a preceding analogy. Full answer provided.
- 70-84 = borderline. Some analogies present but gaps remain.
- < 70 = fail. Multiple technical terms without plain-language lead-ins. MUST be rewritten.
- "layman_first" is CRITICAL if ANY technical term (function names, protocol names, data formats, code concepts) appears without a preceding plain-language explanation in the same response.
- "non_answer" is CRITICAL if the response does ANY of these: references a previous answer instead of providing one ("scroll up", "already covered", "as I said", "see above", "answer is above"); suggests the user has a problem instead of answering ("is something wrong on your end?", "client glitch", "messages not loading?"); gives meta-commentary about the question instead of answering ("you've asked this X times", "same question again"); responds with attitude or sarcasm instead of substance; provides a summary or pointer instead of the full explanation asked for; answers a DIFFERENT question than what was asked; says anything other than a direct, complete, helpful answer to the exact question; references or defers to a previous response in ANY way instead of answering fully right now. The test: if the CEO read ONLY this response, would they have the full answer without needing to scroll, search, or ask again? If no = CRITICAL violation. REPEATED QUESTIONS: If the same question appears multiple times, EVERY response must be complete. Never reference previous answers. Never suggest device issues. Treat every message as the first time it was ever asked.
- "decision_confirmation" is CRITICAL if decisions are presented as final without noting CEO approval needed.
- "assumptions" is WARNING if business assumptions aren't stated explicitly.
- Short responses (<100 chars) or code-only output: score 90+.
- The question topic does NOT excuse jargon. Even if the CEO asks "how does the interceptor work," the answer must start with an analogy.

<response>
{RESPONSE}
</response>`;

/**
 * Call Haiku to evaluate response quality.
 * Routes through the host-executor's /quality-check endpoint, which has
 * the real API key and calls Haiku directly. Containers never touch API keys.
 *
 * Why not call Anthropic directly from the container?
 * - /v1/messages does not accept OAuth tokens (Anthropic limitation)
 * - Containers don't have API keys (security: credential proxy handles SDK auth)
 * - Host-executor runs on the VPS host with access to ~/.atlas/.env
 */
async function callHaiku(responseText: string): Promise<QualityCheckResult> {
  // The host-executor runs a quality-check server on port 3002.
  // Containers reach the host via host.docker.internal.
  const hostGateway = process.env.CONTAINER_HOST_GATEWAY || 'host.docker.internal';
  const port = 3002;
  const url = `http://${hostGateway}:${port}/quality-check`;

  const body = JSON.stringify({ response: responseText.slice(0, 4000) });
  const log = (msg: string) => console.error(`[response-interceptor] ${msg}`);

  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 12000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              log(`Host quality-check returned ${res.statusCode}: ${data.slice(0, 200)}`);
              resolve({ pass: true, violations: [], score: -1 });
              return;
            }
            const result = JSON.parse(data);
            const score = typeof result.score === 'number' ? result.score : 50;
            const violations: QualityViolation[] = Array.isArray(result.violations)
              ? result.violations.filter((v: QualityViolation) => v.rule && v.severity)
              : [];

            log(`Haiku evaluated: score=${score} violations=${violations.length}`);
            resolve({
              pass: score >= 85,
              violations,
              score,
            });
          } catch (err) {
            log(`Quality-check parse error: ${err instanceof Error ? err.message : String(err)}`);
            log(`Raw response: ${data.slice(0, 300)}`);
            resolve({ pass: true, violations: [], score: -2 });
          }
        });
      },
    );

    req.on('error', (err) => {
      log(`Quality-check network error: ${err.message}`);
      resolve({ pass: true, violations: [], score: -3 });
    });

    req.on('timeout', () => {
      log('Quality-check timed out (12s)');
      req.destroy();
      resolve({ pass: true, violations: [], score: -4 });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Build a correction prompt that tells the SDK to rewrite its response.
 */
export function buildCorrectionPrompt(violations: QualityViolation[]): string {
  const criticals = violations.filter((v) => v.severity === 'critical');
  const rules: string[] = [];

  for (const v of criticals) {
    if (v.rule === 'layman_first') {
      rules.push(
        `LAYMAN-FIRST: ${v.description}. Restate using a plain-language analogy BEFORE any technical terms. ` +
        `Start with "Think of it like..." or explain in words someone who has never written code would understand.`
      );
    } else if (v.rule === 'decision_confirmation') {
      rules.push(
        `DECISION CONFIRMATION: ${v.description}. Split into "CEO confirmed" vs "still needs your call" sections.`
      );
    } else if (v.rule === 'assumptions') {
      rules.push(
        `ASSUMPTIONS: ${v.description}. State assumptions explicitly as "I'm assuming X — correct me if wrong."`
      );
    } else if (v.rule === 'non_answer') {
      rules.push(
        `NON-ANSWER: ${v.description}. Answer the question FULLY right now. Do not reference previous answers, ` +
        `do not tell the user to scroll up, do not say "already covered," do not suggest the user has a device problem. ` +
        `Provide the complete answer as if this is the first time it was ever asked.`
      );
    }
  }

  return (
    `Your previous response violated quality rules. Rewrite it following these corrections:\n\n` +
    rules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
    `\n\nRestate your ENTIRE previous response with these fixes applied. ` +
    `Do NOT say "here is the corrected version" — just give the corrected response directly.`
  );
}

/**
 * Log interception results for the learning system.
 */
function logInterception(entry: InterceptionLog): void {
  try {
    const dir = path.join(ATLAS_STATE_DIR, 'audit', entry.entity);
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(dir, `interceptions-${date}.jsonl`);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Never crash on logging failure
  }
}

/**
 * Check response quality and determine if a retry is needed.
 *
 * Returns the check result. The caller decides whether to retry
 * based on `result.pass` and whether a retry has already happened.
 */
export async function checkResponseQuality(
  responseText: string,
): Promise<QualityCheckResult> {
  // Skip check for very short responses (acknowledgments, confirmations)
  if (!responseText || responseText.length < 100) {
    return { pass: true, violations: [], score: 95 };
  }

  // Skip check for code-only responses (no prose to evaluate)
  const codeBlockRatio = (responseText.match(/```/g) || []).length / 2;
  const lines = responseText.split('\n').length;
  if (codeBlockRatio > 0 && codeBlockRatio * 10 > lines * 0.7) {
    return { pass: true, violations: [], score: 90 };
  }

  return callHaiku(responseText);
}

/**
 * Log the full interception lifecycle (original check, retry, final result).
 */
export function logInterceptionResult(
  entity: string,
  originalResult: QualityCheckResult,
  retried: boolean,
  finalResult: QualityCheckResult | null,
  responseLength: number,
): void {
  logInterception({
    timestamp: new Date().toISOString(),
    entity,
    originalScore: originalResult.score,
    retried,
    finalScore: finalResult?.score ?? originalResult.score,
    violations: originalResult.violations.map((v) => `${v.rule}:${v.severity}`),
    responseLength,
  });
}
