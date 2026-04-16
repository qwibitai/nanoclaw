import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  query,
  SDKRateLimitEvent,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  createDefaultDeps,
  buildReplacements,
  renderSystemPrompt,
} from './system-prompt.js';
import { createPreCompactHook, createSessionStartHook } from './hooks.js';
import {
  MessageStream,
  drainIpcInput,
  shouldClose,
} from './ipc.js';
import { log, stripInternalTags, writeOutput } from './io.js';
import { loadMcpConfig, McpServerConfig } from './mcp-config.js';
import { resolveThinkingBudget } from './thinking.js';
import type { ContainerInput } from './types.js';
import {
  IPC_POLL_MS,
  WORKSPACE_EXTRA,
  WORKSPACE_GLOBAL,
  WORKSPACE_GROUP,
} from './workspace.js';

export interface QueryRunnerResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion. Also pipes IPC
 * messages into the stream during the query.
 */
export async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<QueryRunnerResult> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastFinalText: string | null = null;
  let streamingTextBuffer = '';
  let completedTurnsText = '';
  let compactedDuringQuery = false;
  let lastRateLimitInfo: SDKRateLimitEvent['rate_limit_info'] | undefined;

  // Build dynamic system prompt from template + identity/memory/warm context
  const systemPromptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'system-prompt.md',
  );
  const template = fs.existsSync(systemPromptPath)
    ? fs.readFileSync(systemPromptPath, 'utf-8')
    : undefined;

  let dynamicSystemPrompt: string | undefined;
  if (template) {
    const deps = createDefaultDeps(log);
    const replacements = await buildReplacements(
      deps,
      containerInput,
      WORKSPACE_GROUP,
      WORKSPACE_GLOBAL,
    );
    dynamicSystemPrompt = renderSystemPrompt(template, replacements);
    log(
      `Dynamic system prompt built (${dynamicSystemPrompt.length} chars, ${Object.keys(replacements).length} placeholders filled)`,
    );
  }

  // Discover additional directories mounted at extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA;
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Load declarative MCP server configs (global + per-group, group wins on collision)
  const globalMcpServers = loadMcpConfig(
    path.join(WORKSPACE_GLOBAL, 'mcp-servers.json'),
  );
  const groupMcpServers = loadMcpConfig(
    path.join(WORKSPACE_GROUP, 'mcp-servers.json'),
  );
  const additionalMcpServers: Record<string, McpServerConfig> = {
    ...globalMcpServers,
    ...groupMcpServers,
  };
  // Prevent overriding the built-in nanoclaw server
  delete additionalMcpServers['nanoclaw'];
  if (Object.keys(additionalMcpServers).length > 0) {
    log(
      `Additional MCP servers: ${Object.keys(additionalMcpServers).join(', ')}`,
    );
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: containerInput.model || undefined,
      thinking: resolveThinkingBudget(containerInput.thinking_budget),
      effort:
        (containerInput.effort as 'low' | 'medium' | 'high' | 'max') ||
        undefined,
      cwd: WORKSPACE_GROUP,
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH || undefined,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: dynamicSystemPrompt ?? undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        ...Object.keys(additionalMcpServers).map((name) => `mcp__${name}__*`),
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            NANOCLAW_IPC_DIR: process.env.NANOCLAW_IPC_DIR || '/workspace/ipc',
            NANOCLAW_GROUP_DIR: process.env.NANOCLAW_GROUP_DIR || '/workspace',
          },
        },
        ...additionalMcpServers,
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
        SessionStart: [
          { hooks: [createSessionStartHook(containerInput.isMain)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'rate_limit_event') {
      const rlEvent = message as unknown as SDKRateLimitEvent;
      lastRateLimitInfo = rlEvent.rate_limit_info;
      log(
        `Rate limit: status=${rlEvent.rate_limit_info.status} utilization=${rlEvent.rate_limit_info.utilization ?? 'N/A'} type=${rlEvent.rate_limit_info.rateLimitType ?? 'N/A'}`,
      );
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      compactedDuringQuery = true;
      log(`Compact boundary observed`);
      writeOutput({
        status: 'success',
        result: null,
        newSessionId,
        compacted: true,
      });
    }

    if (message.type === 'stream_event') {
      const event = (
        message as {
          event: {
            type: string;
            delta?: { type?: string; text?: string };
          };
        }
      ).event;
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        event.delta.text
      ) {
        streamingTextBuffer += event.delta.text;

        const fullText = completedTurnsText
          ? completedTurnsText + '\n\n' + streamingTextBuffer
          : streamingTextBuffer;
        const visible = stripInternalTags(fullText);
        if (visible) {
          writeOutput({
            status: 'success',
            result: visible,
            partial: true,
            newSessionId,
          });
        }
      }
      // Reset buffers when a new message starts — only the final turn's
      // text appears in the SDK result, so don't accumulate across turns.
      if (event.type === 'message_start') {
        streamingTextBuffer = '';
      }
    }

    if (message.type === 'assistant') {
      // Complete assistant turn — move current buffer to completed turns
      if (streamingTextBuffer) {
        completedTurnsText = completedTurnsText
          ? completedTurnsText + '\n\n' + streamingTextBuffer
          : streamingTextBuffer;
      }
      streamingTextBuffer = '';
    }

    if (message.type === 'result') {
      resultCount++;
      const resultMsg = message as unknown as SDKResultMessage;
      const sdkText =
        'result' in resultMsg
          ? ((resultMsg as { result?: string }).result ?? null)
          : null;
      // Use accumulated text from all turns — SDK result only has the last turn
      const textResult = completedTurnsText || sdkText;
      const usage = resultMsg.usage
        ? {
            inputTokens: resultMsg.usage.input_tokens,
            outputTokens: resultMsg.usage.output_tokens,
            numTurns: resultMsg.num_turns ?? 0,
          }
        : undefined;
      const modelUsageEntries = Object.values(
        (
          resultMsg as unknown as {
            modelUsage?: Record<string, { contextWindow?: number }>;
          }
        ).modelUsage ?? {},
      );
      const contextWindow =
        modelUsageEntries.length > 0
          ? modelUsageEntries[0].contextWindow
          : undefined;
      if (textResult && textResult === lastFinalText) {
        log(`Result #${resultCount}: SKIPPED (duplicate)`);
      } else {
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        lastFinalText = textResult;
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
          usage,
          contextWindow,
          compacted: compactedDuringQuery || undefined,
          rateLimit: lastRateLimitInfo
            ? {
                utilization: lastRateLimitInfo.utilization,
                resetsAt: lastRateLimitInfo.resetsAt,
                rateLimitType: lastRateLimitInfo.rateLimitType,
              }
            : undefined,
        });
      }
      compactedDuringQuery = false;
      // Reset streaming buffers for next user turn within the same runQuery
      completedTurnsText = '';
      streamingTextBuffer = '';
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}
