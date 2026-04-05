import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../shared/logger.ts';

export interface AgentResult {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  error?: string;
}

export async function runAgent(options: {
  prompt: string;
  cwd: string;
  sessionId?: string;
  systemPrompt?: string;
}): Promise<AgentResult> {
  let resultText: string | null = null;
  let newSessionId: string | undefined;
  let messageCount = 0;

  try {
    for await (const message of query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        resume: options.sessionId,
        model: 'sonnet',
        allowedTools: [
          'Read',
          'Write',
          'Edit',
          'Grep',
          'Glob',
          'WebSearch',
          'WebFetch',
          'Skill',
          'ToolSearch',
        ],
        systemPrompt: options.systemPrompt
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: options.systemPrompt,
            }
          : undefined,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      messageCount++;

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = (message as { session_id: string }).session_id;
        logger.debug({ sessionId: newSessionId }, 'Session initialized');
      }

      if (message.type === 'result') {
        const text =
          'result' in message
            ? (message as { result?: string }).result
            : null;
        if (text) resultText = text;
      }
    }

    logger.info(
      { messageCount, hasResult: !!resultText },
      'Agent query complete',
    );

    return {
      status: resultText !== null ? 'success' : 'error',
      result: resultText,
      sessionId: newSessionId,
      error: resultText === null ? 'No result from agent' : undefined,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Agent query failed');
    return {
      status: 'error',
      result: null,
      sessionId: newSessionId,
      error: errorMessage,
    };
  }
}
