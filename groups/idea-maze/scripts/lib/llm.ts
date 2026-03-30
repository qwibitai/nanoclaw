/**
 * Minimal Anthropic API client for running inside NanoClaw containers.
 *
 * Uses the ANTHROPIC_API_KEY environment variable (injected by OneCLI
 * or set directly). Falls back gracefully when no key is available.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const EXTRACTION_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap for bulk extraction
const RESEARCH_MODEL = "claude-sonnet-4-6"; // full reasoning for research drafts

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callApi<T>(model: string, systemPrompt: string, userPrompt: string, maxTokens = 4096): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text: string = data.content?.[0]?.text ?? "";

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[1].trim()) as T;
}

/** Single-item extraction using Haiku */
export async function generateJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(EXTRACTION_MODEL, systemPrompt, userPrompt);
}

/** Research drafting using Sonnet */
export async function generateResearchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(RESEARCH_MODEL, systemPrompt, userPrompt, 8192);
}

/** Batch extraction: sends up to BATCH_SIZE items in one Haiku call */
export const EXTRACTION_BATCH_SIZE = 8;

export async function generateBatchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(EXTRACTION_MODEL, systemPrompt, userPrompt, 8192);
}
