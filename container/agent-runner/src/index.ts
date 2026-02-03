/**
 * DotClaw Agent Runner (OpenRouter)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenRouter, stepCountIs } from '@openrouter/sdk';
import { createTools, ToolCallRecord, ToolPolicy } from './tools.js';
import { createIpcHandlers } from './ipc.js';
import {
  createSessionContext,
  appendHistory,
  loadHistory,
  splitRecentHistory,
  shouldCompact,
  archiveConversation,
  buildSummaryPrompt,
  parseSummaryResponse,
  retrieveRelevantMemories,
  estimateTokens,
  saveMemoryState,
  writeHistory,
  MemoryConfig,
  Message
} from './memory.js';
import { loadPromptPackWithCanary, formatTaskExtractionPack, formatResponseQualityPack, formatToolCallingPack, formatMemoryPolicyPack, PromptPack } from './prompt-packs.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  userId?: string;
  userName?: string;
  memoryRecall?: string[];
  userProfile?: string | null;
  memoryStats?: {
    total: number;
    user: number;
    group: number;
    global: number;
  };
  behaviorConfig?: Record<string, unknown>;
  toolPolicy?: ToolPolicy;
  modelOverride?: string;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  modelTemperature?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
  prompt_pack_versions?: Record<string, string>;
  memory_summary?: string;
  memory_facts?: string[];
  tool_calls?: ToolCallRecord[];
  latency_ms?: number;
}

const OUTPUT_START_MARKER = '---DOTCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DOTCLAW_OUTPUT_END---';

const SESSION_ROOT = '/workspace/session';
const GROUP_DIR = '/workspace/group';
const IPC_DIR = '/workspace/ipc';
const GLOBAL_DIR = '/workspace/global';
const PROMPTS_DIR = '/workspace/prompts';

const PROMPT_PACKS_ENABLED = !['0', 'false', 'no', 'off'].includes((process.env.DOTCLAW_PROMPT_PACKS_ENABLED || '').toLowerCase());
const PROMPT_PACKS_MAX_CHARS = parseInt(process.env.DOTCLAW_PROMPT_PACKS_MAX_CHARS || '6000', 10);
const PROMPT_PACKS_MAX_DEMOS = parseInt(process.env.DOTCLAW_PROMPT_PACKS_MAX_DEMOS || '4', 10);
const PROMPT_PACKS_CANARY_RATE = parseFloat(process.env.DOTCLAW_PROMPT_PACKS_CANARY_RATE || '0.1');

let cachedOpenRouter: OpenRouter | null = null;
let cachedOpenRouterKey = '';
let cachedOpenRouterOptions = '';

function getCachedOpenRouter(apiKey: string, options: ReturnType<typeof getOpenRouterOptions>): OpenRouter {
  const optionsKey = JSON.stringify(options);
  if (cachedOpenRouter && cachedOpenRouterKey === apiKey && cachedOpenRouterOptions === optionsKey) {
    return cachedOpenRouter;
  }
  cachedOpenRouter = new OpenRouter({
    apiKey,
    ...options
  });
  cachedOpenRouterKey = apiKey;
  cachedOpenRouterOptions = optionsKey;
  return cachedOpenRouter;
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function runSelfCheck(params: {
  model: string;
}) {
  const details: string[] = [];

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  fs.mkdirSync(GROUP_DIR, { recursive: true });
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
  fs.mkdirSync(IPC_DIR, { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'tasks'), { recursive: true });

  const filePath = path.join(GROUP_DIR, '.dotclaw-selfcheck');
  fs.writeFileSync(filePath, `self-check-${Date.now()}`);
  const readBack = fs.readFileSync(filePath, 'utf-8');
  if (!readBack.startsWith('self-check-')) {
    throw new Error('Failed to read back self-check file');
  }
  fs.unlinkSync(filePath);
  details.push('group directory writable');

  const sessionPath = path.join(SESSION_ROOT, 'self-check');
  fs.mkdirSync(sessionPath, { recursive: true });
  const sessionFile = path.join(sessionPath, 'probe.txt');
  fs.writeFileSync(sessionFile, 'ok');
  fs.readFileSync(sessionFile, 'utf-8');
  fs.unlinkSync(sessionFile);
  details.push('session directory writable');

  const ipcFile = path.join(IPC_DIR, 'messages', `self-check-${Date.now()}.json`);
  fs.writeFileSync(ipcFile, JSON.stringify({ ok: true }, null, 2));
  fs.unlinkSync(ipcFile);
  details.push('ipc directory writable');

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (process.env.OPENROUTER_SITE_URL) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  }
  if (process.env.OPENROUTER_SITE_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_SITE_NAME;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: 'Return exactly the string "OK".' }],
      max_tokens: 8,
      temperature: 0
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  try {
    const data = JSON.parse(bodyText);
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
    if (!content || !String(content).trim()) {
      throw new Error('OpenRouter call returned empty response');
    }
  } catch (err) {
    throw new Error(`OpenRouter response parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  details.push('openrouter call ok');

  return details;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function getConfig(): MemoryConfig & {
  maxOutputTokens: number;
  summaryMaxOutputTokens: number;
  temperature: number;
} {
  return {
    maxContextTokens: parseInt(process.env.DOTCLAW_MAX_CONTEXT_TOKENS || '200000', 10),
    compactionTriggerTokens: parseInt(process.env.DOTCLAW_COMPACTION_TRIGGER_TOKENS || '180000', 10),
    recentContextTokens: parseInt(process.env.DOTCLAW_RECENT_CONTEXT_TOKENS || '80000', 10),
    summaryUpdateEveryMessages: parseInt(process.env.DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES || '12', 10),
    memoryMaxResults: parseInt(process.env.DOTCLAW_MEMORY_MAX_RESULTS || '6', 10),
    memoryMaxTokens: parseInt(process.env.DOTCLAW_MEMORY_MAX_TOKENS || '2000', 10),
    maxOutputTokens: parseInt(process.env.DOTCLAW_MAX_OUTPUT_TOKENS || '4096', 10),
    summaryMaxOutputTokens: parseInt(process.env.DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS || '1200', 10),
    temperature: parseFloat(process.env.DOTCLAW_TEMPERATURE || '0.2')
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabledEnv(name: string, defaultValue = true): boolean {
  const value = (process.env[name] || '').toLowerCase().trim();
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value);
}

function getOpenRouterOptions() {
  const timeoutMs = parsePositiveInt(process.env.DOTCLAW_OPENROUTER_TIMEOUT_MS, 240_000);
  const retryEnabled = isEnabledEnv('DOTCLAW_OPENROUTER_RETRY', true);
  const retryConfig = retryEnabled
    ? {
      strategy: 'backoff' as const,
      backoff: {
        initialInterval: 500,
        maxInterval: 5000,
        exponent: 2,
        maxElapsedTime: 20_000
      },
      retryConnectionErrors: true
    }
    : { strategy: 'none' as const };

  return {
    timeoutMs,
    retryConfig,
    httpReferer: process.env.OPENROUTER_SITE_URL,
    xTitle: process.env.OPENROUTER_SITE_NAME
  };
}

function buildSystemInstructions(params: {
  assistantName: string;
  memorySummary: string;
  memoryFacts: string[];
  sessionRecall: string[];
  longTermRecall: string[];
  userProfile?: string | null;
  memoryStats?: { total: number; user: number; group: number; global: number };
  behaviorConfig?: Record<string, unknown>;
  isScheduledTask: boolean;
  taskExtractionPack?: PromptPack | null;
  responseQualityPack?: PromptPack | null;
  toolCallingPack?: PromptPack | null;
  memoryPolicyPack?: PromptPack | null;
}): string {
  const toolsDoc = [
    'Tools available (use with care):',
    '- `Bash`: run shell commands in `/workspace/group`.',
    '- `Read`, `Write`, `Edit`, `Glob`, `Grep`: filesystem operations within mounted paths.',
    '- `WebSearch`: Brave Search API (requires `BRAVE_SEARCH_API_KEY`).',
    '- `WebFetch`: fetch URLs (limit payload sizes).',
    '- `mcp__dotclaw__send_message`: send Telegram messages.',
    '- `mcp__dotclaw__schedule_task`: schedule tasks.',
    '- `mcp__dotclaw__list_tasks`, `mcp__dotclaw__pause_task`, `mcp__dotclaw__resume_task`, `mcp__dotclaw__cancel_task`.',
    '- `mcp__dotclaw__register_group`: main group only.',
    '- `mcp__dotclaw__set_model`: main group only.',
    '- `mcp__dotclaw__memory_upsert`: store durable memories.',
    '- `mcp__dotclaw__memory_search`, `mcp__dotclaw__memory_list`, `mcp__dotclaw__memory_forget`, `mcp__dotclaw__memory_stats`.',
    '- `plugin__*`: dynamically loaded plugin tools (if present and allowed by policy).'
  ].join('\n');

  const memorySummary = params.memorySummary ? params.memorySummary : 'None yet.';
  const memoryFacts = params.memoryFacts.length > 0
    ? params.memoryFacts.map(fact => `- ${fact}`).join('\n')
    : 'None yet.';
  const sessionRecall = params.sessionRecall.length > 0
    ? params.sessionRecall.map(item => `- ${item}`).join('\n')
    : 'None.';

  const longTermRecall = params.longTermRecall.length > 0
    ? params.longTermRecall.map(item => `- ${item}`).join('\n')
    : 'None.';

  const userProfile = params.userProfile
    ? params.userProfile
    : 'None.';

  const memoryStats = params.memoryStats
    ? `Total: ${params.memoryStats.total}, User: ${params.memoryStats.user}, Group: ${params.memoryStats.group}, Global: ${params.memoryStats.global}`
    : 'Unknown.';

  const behaviorNotes: string[] = [];
  const responseStyle = typeof params.behaviorConfig?.response_style === 'string'
    ? String(params.behaviorConfig.response_style)
    : '';
  if (responseStyle === 'concise') {
    behaviorNotes.push('Response style: concise and action-oriented.');
  } else if (responseStyle === 'detailed') {
    behaviorNotes.push('Response style: detailed and step-by-step where helpful.');
  }
  const toolBias = typeof params.behaviorConfig?.tool_calling_bias === 'number'
    ? Number(params.behaviorConfig.tool_calling_bias)
    : null;
  if (toolBias !== null && toolBias < 0.4) {
    behaviorNotes.push('Tool usage: be conservative, ask clarifying questions before calling tools.');
  } else if (toolBias !== null && toolBias > 0.6) {
    behaviorNotes.push('Tool usage: be proactive when tools add accuracy or save time.');
  }
  const cautionBias = typeof params.behaviorConfig?.caution_bias === 'number'
    ? Number(params.behaviorConfig.caution_bias)
    : null;
  if (cautionBias !== null && cautionBias > 0.6) {
    behaviorNotes.push('Caution: verify uncertain facts and flag limitations.');
  }

  const behaviorConfig = params.behaviorConfig
    ? `Behavior overrides:\n${JSON.stringify(params.behaviorConfig, null, 2)}`
    : '';

  const scheduledNote = params.isScheduledTask
    ? 'You are running as a scheduled task. If you need to communicate, use `mcp__dotclaw__send_message`.'
    : '';

  const taskExtractionBlock = params.taskExtractionPack
    ? formatTaskExtractionPack({
      pack: params.taskExtractionPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const responseQualityBlock = params.responseQualityPack
    ? formatResponseQualityPack({
      pack: params.responseQualityPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const toolCallingBlock = params.toolCallingPack
    ? formatToolCallingPack({
      pack: params.toolCallingPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const memoryPolicyBlock = params.memoryPolicyPack
    ? formatMemoryPolicyPack({
      pack: params.memoryPolicyPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  return [
    `You are ${params.assistantName}, a personal assistant running inside DotClaw.`,
    scheduledNote,
    toolsDoc,
    toolCallingBlock,
    taskExtractionBlock,
    responseQualityBlock,
    memoryPolicyBlock,
    'Long-term memory summary:',
    memorySummary,
    'Long-term facts:',
    memoryFacts,
    'User profile (if available):',
    userProfile,
    'Long-term memory recall (durable facts/preferences):',
    longTermRecall,
    'Session recall (recent/older conversation snippets):',
    sessionRecall,
    'Memory stats:',
    memoryStats,
    behaviorNotes.length > 0 ? `Behavior notes:\n${behaviorNotes.join('\n')}` : '',
    behaviorConfig,
    'Respond succinctly and helpfully. If you perform tool actions, summarize the results.'
  ].filter(Boolean).join('\n\n');
}

function extractQueryFromPrompt(prompt: string): string {
  if (!prompt) return '';
  const messageMatches = [...prompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (messageMatches.length > 0) {
    const last = messageMatches[messageMatches.length - 1][1];
    return decodeXml(last).trim();
  }
  return prompt.trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function messagesToOpenRouter(messages: Message[]) {
  return messages.map(message => ({
    role: message.role,
    content: message.content
  }));
}

async function updateMemorySummary(params: {
  openrouter: OpenRouter;
  model: string;
  existingSummary: string;
  existingFacts: string[];
  newMessages: Message[];
  maxOutputTokens: number;
}): Promise<{ summary: string; facts: string[] } | null> {
  if (params.newMessages.length === 0) return null;
  const prompt = buildSummaryPrompt(params.existingSummary, params.existingFacts, params.newMessages);
  const result = await params.openrouter.callModel({
    model: params.model,
    instructions: prompt.instructions,
    input: prompt.input,
    maxOutputTokens: params.maxOutputTokens,
    temperature: 0.1
  });
  const text = await result.getText();
  return parseSummaryResponse(text);
}

function buildMemoryExtractionPrompt(params: {
  assistantName: string;
  userId?: string;
  userName?: string;
  messages: Message[];
  memoryPolicyPack?: PromptPack | null;
}): { instructions: string; input: string } {
  const policyBlock = params.memoryPolicyPack
    ? formatMemoryPolicyPack({
      pack: params.memoryPolicyPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const instructions = [
    `You are ${params.assistantName}'s long-term memory extractor.`,
    'Extract durable, user-approved memories only.',
    'Prefer stable facts, preferences, identity details, projects, and long-running tasks.',
    'Avoid transient details, ephemeral scheduling, or speculative statements.',
    'If the user explicitly asked to remember something, include it.',
    'Return JSON only with key "items": array of memory objects.',
    'Each item fields:',
    '- scope: "user" | "group" | "global"',
    '- subject_id: user id for user scope (optional for group/global)',
    '- type: "identity" | "preference" | "fact" | "relationship" | "project" | "task" | "note"',
    '- content: the memory string',
    '- importance: 0-1 (higher = more important)',
    '- confidence: 0-1',
    '- tags: array of short tags',
    '- ttl_days: optional number (omit for permanent memories).',
    policyBlock
  ].filter(Boolean).join('\n');

  const transcript = params.messages
    .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join('\n\n');

  const input = [
    `User: ${params.userName || 'Unknown'} (${params.userId || 'unknown'})`,
    'Transcript:',
    transcript
  ].join('\n\n');

  return { instructions, input };
}

function parseMemoryExtraction(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter((item: unknown) => !!item && typeof item === 'object');
  } catch {
    return [];
  }
}

export async function runAgentOnce(input: ContainerInput): Promise<ContainerOutput> {
  log(`Received input for group: ${input.groupFolder}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      status: 'error',
      result: null,
      error: 'OPENROUTER_API_KEY is not set'
    };
  }

  const model = input.modelOverride || process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
  const summaryModel = process.env.DOTCLAW_SUMMARY_MODEL || model;
  const memoryModel = process.env.DOTCLAW_MEMORY_MODEL || summaryModel;
  const assistantName = process.env.ASSISTANT_NAME || 'Rain';
  const config = getConfig();
  if (input.modelContextTokens && Number.isFinite(input.modelContextTokens)) {
    config.maxContextTokens = Math.min(config.maxContextTokens, input.modelContextTokens);
    const compactionTarget = input.modelContextTokens - config.maxOutputTokens;
    config.compactionTriggerTokens = Math.max(1000, Math.min(config.compactionTriggerTokens, compactionTarget));
  }
  if (input.modelMaxOutputTokens && Number.isFinite(input.modelMaxOutputTokens)) {
    config.maxOutputTokens = Math.min(config.maxOutputTokens, input.modelMaxOutputTokens);
  }
  if (input.modelTemperature && Number.isFinite(input.modelTemperature)) {
    config.temperature = input.modelTemperature;
  }
  const openrouterOptions = getOpenRouterOptions();
  const maxToolSteps = parsePositiveInt(process.env.DOTCLAW_MAX_TOOL_STEPS, 12);
  const memoryExtractionEnabled = isEnabledEnv('DOTCLAW_MEMORY_EXTRACTION_ENABLED', true);
  const memoryExtractionMaxMessages = parsePositiveInt(process.env.DOTCLAW_MEMORY_EXTRACTION_MESSAGES, 8);
  const memoryExtractionMaxOutputTokens = parsePositiveInt(process.env.DOTCLAW_MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS, 900);
  const memoryExtractScheduled = isEnabledEnv('DOTCLAW_MEMORY_EXTRACT_SCHEDULED', false);
  const memoryArchiveSync = isEnabledEnv('DOTCLAW_MEMORY_ARCHIVE_SYNC', true);

  const openrouter = getCachedOpenRouter(apiKey, openrouterOptions);

  const { ctx: sessionCtx, isNew } = createSessionContext(SESSION_ROOT, input.sessionId);
  const toolCalls: ToolCallRecord[] = [];
  const ipc = createIpcHandlers({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });
  const tools = createTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, {
    onToolCall: (call) => {
      toolCalls.push(call);
    },
    policy: input.toolPolicy
  });

  if (process.env.DOTCLAW_SELF_CHECK === '1') {
    try {
      const details = await runSelfCheck({ model });
      return {
        status: 'success',
        result: `Self-check passed: ${details.join(', ')}`,
        newSessionId: isNew ? sessionCtx.sessionId : undefined
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Self-check failed: ${errorMessage}`);
      return {
        status: 'error',
        result: null,
        newSessionId: isNew ? sessionCtx.sessionId : undefined,
        error: errorMessage
      };
    }
  }

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__dotclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  appendHistory(sessionCtx, 'user', prompt);
  let history = loadHistory(sessionCtx);

  const totalTokens = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  let { recentMessages, olderMessages } = splitRecentHistory(history, config.recentContextTokens);

  if (shouldCompact(totalTokens, config)) {
    log(`Compacting history: ${totalTokens} tokens`);
    archiveConversation(history, sessionCtx.state.summary || null, GROUP_DIR);

    const summaryUpdate = await updateMemorySummary({
      openrouter,
      model: summaryModel,
      existingSummary: sessionCtx.state.summary,
      existingFacts: sessionCtx.state.facts,
      newMessages: olderMessages,
      maxOutputTokens: config.summaryMaxOutputTokens
    });

    if (summaryUpdate) {
      sessionCtx.state.summary = summaryUpdate.summary;
      sessionCtx.state.facts = summaryUpdate.facts;
      sessionCtx.state.lastSummarySeq = olderMessages.length > 0
        ? olderMessages[olderMessages.length - 1].seq
        : sessionCtx.state.lastSummarySeq;
      saveMemoryState(sessionCtx);

      if (memoryArchiveSync) {
        try {
          const archiveItems: Array<Record<string, unknown>> = [];
          if (summaryUpdate.summary) {
            archiveItems.push({
              scope: 'group',
              type: 'archive',
              content: `Conversation summary: ${summaryUpdate.summary}`,
              importance: 0.6,
              confidence: 0.7,
              tags: ['summary', 'archive']
            });
          }
          for (const fact of summaryUpdate.facts || []) {
            if (!fact || typeof fact !== 'string') continue;
            archiveItems.push({
              scope: 'group',
              type: 'fact',
              content: fact,
              importance: 0.7,
              confidence: 0.7,
              tags: ['fact', 'archive']
            });
          }
          if (archiveItems.length > 0) {
            await ipc.memoryUpsert({ items: archiveItems, source: 'compaction' });
          }
        } catch (err) {
          log(`Memory archive sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    writeHistory(sessionCtx, recentMessages);
    history = recentMessages;
  }

  // Recompute split after possible compaction
  ({ recentMessages, olderMessages } = splitRecentHistory(history, config.recentContextTokens));

  const query = extractQueryFromPrompt(prompt);
  const sessionRecall = retrieveRelevantMemories({
    query,
    summary: sessionCtx.state.summary,
    facts: sessionCtx.state.facts,
    olderMessages,
    config
  });

  const sharedPromptDir = fs.existsSync(PROMPTS_DIR) ? PROMPTS_DIR : undefined;
  const taskPackResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'task-extraction', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const responseQualityResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'response-quality', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const toolCallingResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'tool-calling', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const memoryPolicyResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'memory-policy', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;

  const logPack = (label: string, result: { pack: PromptPack; source: string; isCanary?: boolean } | null) => {
    if (!result) return;
    const canaryNote = result.isCanary ? ' (canary)' : '';
    log(`Loaded prompt pack (${label}${canaryNote}): ${result.pack.name}@${result.pack.version}`);
  };
  logPack(taskPackResult?.source || 'unknown', taskPackResult);
  logPack(responseQualityResult?.source || 'unknown', responseQualityResult);
  logPack(toolCallingResult?.source || 'unknown', toolCallingResult);
  logPack(memoryPolicyResult?.source || 'unknown', memoryPolicyResult);

  const promptPackVersions: Record<string, string> = {};
  if (taskPackResult) promptPackVersions['task-extraction'] = taskPackResult.pack.version;
  if (responseQualityResult) promptPackVersions['response-quality'] = responseQualityResult.pack.version;
  if (toolCallingResult) promptPackVersions['tool-calling'] = toolCallingResult.pack.version;
  if (memoryPolicyResult) promptPackVersions['memory-policy'] = memoryPolicyResult.pack.version;

  const instructions = buildSystemInstructions({
    assistantName,
    memorySummary: sessionCtx.state.summary,
    memoryFacts: sessionCtx.state.facts,
    sessionRecall,
    longTermRecall: input.memoryRecall || [],
    userProfile: input.userProfile ?? null,
    memoryStats: input.memoryStats,
    behaviorConfig: input.behaviorConfig,
    isScheduledTask: !!input.isScheduledTask,
    taskExtractionPack: taskPackResult?.pack || null,
    responseQualityPack: responseQualityResult?.pack || null,
    toolCallingPack: toolCallingResult?.pack || null,
    memoryPolicyPack: memoryPolicyResult?.pack || null
  });

  const instructionsTokens = estimateTokens(instructions);
  const maxContextTokens = Math.max(config.maxContextTokens - config.maxOutputTokens - instructionsTokens, 2000);
  const { recentMessages: contextMessages } = splitRecentHistory(recentMessages, maxContextTokens, 6);

  let responseText = '';

  let latencyMs: number | undefined;
  try {
    log('Starting OpenRouter call...');
    const startedAt = Date.now();
    const result = await openrouter.callModel({
      model,
      instructions,
      input: messagesToOpenRouter(contextMessages),
      tools,
      stopWhen: stepCountIs(maxToolSteps),
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature
    });
    latencyMs = Date.now() - startedAt;
    // Get tool calls to see what the model did
    const modelToolCalls = await result.getToolCalls();
    if (modelToolCalls.length > 0) {
      log(`Model made ${modelToolCalls.length} tool call(s): ${modelToolCalls.map(t => t.name).join(', ')}`);
    }

    responseText = await result.getText();

    if (!responseText || !responseText.trim()) {
      log(`Warning: Model returned empty/whitespace response. Raw length: ${responseText?.length ?? 0}, tool calls: ${modelToolCalls.length}`);
    } else {
      log(`Model returned text response (${responseText.length} chars)`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return {
      status: 'error',
      result: null,
      newSessionId: isNew ? sessionCtx.sessionId : undefined,
      error: errorMessage,
      model,
      prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
      memory_summary: sessionCtx.state.summary,
      memory_facts: sessionCtx.state.facts,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      latency_ms: latencyMs
    };
  }

  appendHistory(sessionCtx, 'assistant', responseText || '');

  history = loadHistory(sessionCtx);
  const newMessages = history.filter(m => m.seq > sessionCtx.state.lastSummarySeq);
  if (newMessages.length >= config.summaryUpdateEveryMessages) {
    const summaryUpdate = await updateMemorySummary({
      openrouter,
      model: summaryModel,
      existingSummary: sessionCtx.state.summary,
      existingFacts: sessionCtx.state.facts,
      newMessages,
      maxOutputTokens: config.summaryMaxOutputTokens
    });
    if (summaryUpdate) {
      sessionCtx.state.summary = summaryUpdate.summary;
      sessionCtx.state.facts = summaryUpdate.facts;
      sessionCtx.state.lastSummarySeq = newMessages[newMessages.length - 1].seq;
      saveMemoryState(sessionCtx);
    }
  }

  if (memoryExtractionEnabled && (!input.isScheduledTask || memoryExtractScheduled)) {
    try {
      const extractionMessages = history.slice(-memoryExtractionMaxMessages);
      if (extractionMessages.length > 0) {
        const extractionPrompt = buildMemoryExtractionPrompt({
          assistantName,
          userId: input.userId,
          userName: input.userName,
          messages: extractionMessages,
          memoryPolicyPack: memoryPolicyResult?.pack || null
        });
        const extractionResult = await openrouter.callModel({
          model: memoryModel,
          instructions: extractionPrompt.instructions,
          input: extractionPrompt.input,
          maxOutputTokens: memoryExtractionMaxOutputTokens,
          temperature: 0.1
        });
        const extractionText = await extractionResult.getText();
        const extractedItems = parseMemoryExtraction(extractionText);
        if (extractedItems.length > 0) {
          const behaviorThreshold = typeof input.behaviorConfig?.memory_importance_threshold === 'number'
            ? Number(input.behaviorConfig?.memory_importance_threshold)
            : null;
          const normalizedItems = extractedItems
            .filter((item) => {
              if (behaviorThreshold === null) return true;
              const importance = typeof item.importance === 'number' ? item.importance : null;
              if (importance === null) return true;
              return importance >= behaviorThreshold;
            })
            .map((item) => {
            const scope = typeof item.scope === 'string' ? item.scope : '';
            const subject = item.subject_id;
            if (scope === 'user' && !subject && input.userId) {
              return { ...item, subject_id: input.userId };
            }
            return item;
          });
          if (normalizedItems.length > 0) {
            await ipc.memoryUpsert({
              items: normalizedItems as unknown[],
              source: 'agent-extraction'
            });
          }
        }
      }
    } catch (err) {
      log(`Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Normalize empty/whitespace-only responses to null
  const finalResult = responseText && responseText.trim() ? responseText : null;

  return {
    status: 'success',
    result: finalResult,
    newSessionId: isNew ? sessionCtx.sessionId : undefined,
    model,
    prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
    memory_summary: sessionCtx.state.summary,
    memory_facts: sessionCtx.state.facts,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    latency_ms: latencyMs
  };
}

async function main(): Promise<void> {
  try {
    const stdinData = await readStdin();
    const input = JSON.parse(stdinData) as ContainerInput;
    const output = await runAgentOnce(input);
    writeOutput(output);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch(err => {
    log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  });
}
