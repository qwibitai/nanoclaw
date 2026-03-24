import { ChildProcessRunner } from './child-process-runner.js';
import { ManagementServer } from './management/server.js';
import { setRunner, sessionRunIds } from './management/handlers.js';

const MANAGEMENT_PORT = parseInt(process.env.MANAGEMENT_PORT || '18789');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');

async function main() {
  const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });
  setRunner(runner);

  const server = new ManagementServer({ port: MANAGEMENT_PORT });
  await server.start();
  console.log(
    `NanoClaw PaaS management API listening on port ${MANAGEMENT_PORT}`,
  );

  // Wire runner output events to management server event push.
  // Claude Code --output-format stream-json emits one JSON object per line:
  //   {"type":"system", ...}           — init/session info, ignored here
  //   {"type":"assistant","message":{  — agent turn with content blocks
  //     "content":[
  //       {"type":"text","text":"..."}              → chat.delta
  //       {"type":"tool_use","name":"...","input":{}} → agent.tool
  //     ]
  //   }}
  //   {"type":"result","subtype":"success","result":"...","usage":{...}} → chat.final
  runner.on('output', (sessionKey: string, data: string) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    for (const line of data.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'assistant') {
          const content: unknown[] = parsed.message?.content ?? [];
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && b.text) {
              server.pushEvent('chat.delta', {
                sessionKey,
                runId,
                content: b.text,
              });
            } else if (b.type === 'tool_use') {
              server.pushEvent('agent.tool', {
                sessionKey,
                runId,
                tool: b.name || '',
                input: b.input,
                output: null,
              });
            }
          }
        } else if (parsed.type === 'result') {
          const usage = parsed.usage as Record<string, number> | undefined;
          server.pushEvent('chat.final', {
            sessionKey,
            runId,
            content: parsed.result || '',
            usage: {
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
            },
          });
        }
      } catch {
        // Non-JSON line — ignore (startup text, etc.)
      }
    }
  });

  // Emit chat.error to clients when a claude process exits unexpectedly
  runner.on('exit', (sessionKey: string, code: number | null) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    sessionRunIds.delete(sessionKey);
    if (code !== 0) {
      server.pushEvent('chat.error', {
        sessionKey,
        runId,
        error: `Agent process exited with code ${code ?? 'null'}`,
      });
    }
  });

  // Log stderr from agent processes centrally (in addition to per-session
  // onError callback wired in handlers.ts). This catches stderr from any
  // session regardless of how it was spawned.
  runner.on('stderr', (sessionKey: string, data: string) => {
    console.error(`[claude:${sessionKey}] ${data.trimEnd()}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await runner.killAll();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
