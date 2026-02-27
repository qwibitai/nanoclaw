import fs from 'fs';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner/generic-llm] ${message}`);
}

/**
 * Call a generic OpenAI-compatible chat-completions endpoint.
 * Works for:
 * - DeepSeek: https://api.deepseek.com/v1/chat/completions
 * - Zhipu(GLM): https://open.bigmodel.cn/api/paas/v4/chat/completions
 * Configure via env:
 * - LLM_API_BASE
 * - LLM_MODEL
 * - LLM_API_KEY
 */
async function callGenericLlm(
  apiBase: string,
  model: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const url = `${apiBase.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  // OpenAI-compatible response shape: { choices: [{ message: { content } }]}
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM returned empty content');
  }
  return content;
}

export async function runGenericLlm(input: ContainerInput): Promise<void> {
  // Delete the temp file the entrypoint wrote — it contains secrets
  try {
    fs.unlinkSync('/tmp/input.json');
  } catch {}

  const env = { ...process.env, ...(input.secrets || {}) };
  const apiBase = env.LLM_API_BASE || '';
  const apiKey = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || '';

  log(
    `Config: model=${model}, apiBase=${apiBase.replace(/\/[^\/]*$/, '/***')}`,
  );

  if (!apiBase || !apiKey || !model) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Missing LLM_API_BASE/LLM_API_KEY/LLM_MODEL',
    });
    process.exit(1);
    return;
  }

  try {
    log(`Calling ${model}...`);
    const text = await callGenericLlm(apiBase, model, apiKey, input.prompt);
    log(`Got response (${text.length} chars)`);
    writeOutput({
      status: 'success',
      result: text,
      newSessionId: input.sessionId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`LLM error: ${msg}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: input.sessionId,
      error: msg,
    });
    process.exit(1);
  }
}
