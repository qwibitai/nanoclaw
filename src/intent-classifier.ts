import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  classifyPendingInputDetailed,
  PendingInputClassification,
} from './pending-input.js';
import { NewMessage } from './types.js';

interface ResolveIntentOptions {
  busyInteractiveContainer: boolean;
  lastAssistantMessage?: string;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicTextBlock[];
}

const CLASSIFIER_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_CLASSIFIER_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_TIMEOUT_MS = 2000;

function clipText(text: string | undefined, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function getClassifierConfig(): {
  provider: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
} {
  const envVars = readEnvFile([
    'AI_INTENT_CLASSIFIER',
    'AI_INTENT_CLASSIFIER_MODEL',
    'AI_INTENT_CLASSIFIER_TIMEOUT_MS',
    'ANTHROPIC_API_KEY',
  ]);

  const provider =
    process.env.AI_INTENT_CLASSIFIER ||
    envVars.AI_INTENT_CLASSIFIER ||
    'auto';
  const model =
    process.env.AI_INTENT_CLASSIFIER_MODEL ||
    envVars.AI_INTENT_CLASSIFIER_MODEL ||
    DEFAULT_CLASSIFIER_MODEL;
  const timeoutMs = Math.max(
    250,
    parseInt(
      process.env.AI_INTENT_CLASSIFIER_TIMEOUT_MS ||
        envVars.AI_INTENT_CLASSIFIER_TIMEOUT_MS ||
        `${DEFAULT_TIMEOUT_MS}`,
      10,
    ) || DEFAULT_TIMEOUT_MS,
  );
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;

  return { provider: provider.trim().toLowerCase(), model, timeoutMs, apiKey };
}

function shouldUseAiClassifier(
  classification: PendingInputClassification,
  options: ResolveIntentOptions,
): boolean {
  if (!options.busyInteractiveContainer) return false;
  if (classification.kind !== 'chat') return false;
  if (classification.confidence >= 0.6) return false;
  return true;
}

function buildClassifierPrompt(
  messages: NewMessage[],
  classification: PendingInputClassification,
  options: ResolveIntentOptions,
): string {
  const formattedMessages = messages
    .map((message, index) => {
      const replyContext =
        message.reply_to_message_content && message.reply_to_sender_name
          ? `, reply_to_sender=${JSON.stringify(message.reply_to_sender_name)}, reply_to_content=${JSON.stringify(clipText(message.reply_to_message_content, 280))}`
          : '';
      return `message_${index + 1}: sender=${JSON.stringify(message.sender_name)}, content=${JSON.stringify(clipText(message.content, 280))}${replyContext}`;
    })
    .join('\n');

  const assistantMessage = options.lastAssistantMessage
    ? clipText(options.lastAssistantMessage, 600)
    : '(none)';

  return [
    'You classify the latest inbound user intent for NanoClaw.',
    'Return strict JSON only: {"kind":"command|workflow_reply|chat","confidence":0..1,"reason":"short reason"}',
    'Use "workflow_reply" for actionable follow-ups that continue or modify the assistant\'s current work, even if they are short, imperative, or omit explicit context.',
    'Use "chat" only for low-signal or clearly non-actionable conversation.',
    '',
    `Local heuristic guess: ${classification.kind} (confidence ${classification.confidence.toFixed(2)})`,
    `Busy interactive container: ${options.busyInteractiveContainer ? 'yes' : 'no'}`,
    `Last assistant message: ${JSON.stringify(assistantMessage)}`,
    formattedMessages,
  ].join('\n');
}

function parseClassifierResponse(
  rawText: string,
): PendingInputClassification | null {
  const jsonStart = rawText.indexOf('{');
  const jsonEnd = rawText.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  try {
    const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1)) as {
      kind?: string;
      confidence?: number;
      reason?: string;
    };
    if (
      parsed.kind !== 'command' &&
      parsed.kind !== 'workflow_reply' &&
      parsed.kind !== 'chat'
    ) {
      return null;
    }
    return {
      source: 'user',
      kind: parsed.kind,
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : 'AI classifier returned no reason',
      classifier: 'ai',
    };
  } catch {
    return null;
  }
}

async function classifyWithClaude(
  messages: NewMessage[],
  classification: PendingInputClassification,
  options: ResolveIntentOptions,
): Promise<PendingInputClassification | null> {
  const config = getClassifierConfig();
  if (config.provider === 'off') return null;
  if (config.provider !== 'auto' && config.provider !== 'claude') return null;
  if (!config.apiKey) return null;

  const prompt = buildClassifierPrompt(messages, classification, options);

  try {
    const response = await fetch(CLASSIFIER_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      logger.debug(
        { status: response.status },
        'AI intent classifier request failed',
      );
      return null;
    }

    const payload = (await response.json()) as AnthropicResponse;
    const rawText = (payload.content || [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!rawText) return null;

    return parseClassifierResponse(rawText);
  } catch (err) {
    logger.debug({ err }, 'AI intent classifier unavailable');
    return null;
  }
}

export async function resolvePendingInput(
  messages: NewMessage[],
  assistantName: string,
  options: ResolveIntentOptions,
): Promise<PendingInputClassification> {
  const heuristic = classifyPendingInputDetailed(messages, assistantName);
  if (!shouldUseAiClassifier(heuristic, options)) {
    return heuristic;
  }

  const aiClassification = await classifyWithClaude(
    messages,
    heuristic,
    options,
  );
  if (!aiClassification) return heuristic;

  logger.info(
    {
      fromKind: heuristic.kind,
      toKind: aiClassification.kind,
      confidence: aiClassification.confidence,
      reason: aiClassification.reason,
    },
    'AI intent classifier adjusted message classification',
  );

  return aiClassification;
}
