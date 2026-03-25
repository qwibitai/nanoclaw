import { ChildProcessRunner } from './child-process-runner.js';
import {
  ManagementServer,
  createHandlers,
  sessionRunIds,
  parseStreamJsonLine,
} from './management/index.js';

const MANAGEMENT_PORT = parseInt(process.env.MANAGEMENT_PORT || '18789');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');

async function main() {
  const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });

  // Create handlers with a late-bound pushEvent that captures server by reference.
  // eslint-disable-next-line prefer-const -- server must be declared before the closure but assigned after
  let server: ManagementServer;

  const handlers = createHandlers(runner, (event, payload) =>
    server.pushEvent(event, payload),
  );
  server = new ManagementServer({ port: MANAGEMENT_PORT, handlers });
  await server.start();
  console.log(
    `NanoClaw K8s management API listening on port ${MANAGEMENT_PORT}`,
  );

  runner.on('output', (sessionKey: string, data: string) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    for (const line of data.split('\n').filter(Boolean)) {
      for (const ev of parseStreamJsonLine(line, sessionKey, runId)) {
        server.pushEvent(ev.event, ev.payload);
      }
    }
  });

  runner.on('exit', (sessionKey: string, code: number | null) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    sessionRunIds.delete(sessionKey);
    if (code !== 0 && code !== null) {
      server.pushEvent('chat.error', {
        sessionKey,
        runId,
        error: `Agent process exited with code ${code}`,
      });
    }
  });

  runner.on('stderr', (sessionKey: string, data: string) => {
    console.error(`[claude:${sessionKey}] ${data.trimEnd()}`);
  });

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
