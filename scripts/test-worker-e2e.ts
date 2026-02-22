/**
 * E2E test: jarvis-worker container dispatch
 *
 * Tests the full path:
 *   runContainerAgent → container → Claude Agent SDK → output + usage
 *
 * Does NOT require NanoClaw or WhatsApp to be running.
 * Run with: npx tsx scripts/test-worker-e2e.ts
 */
import { runContainerAgent } from '../src/container-runner.js';
import { RegisteredGroup } from '../src/types.js';
import { ChildProcess } from 'child_process';

const WORKER_GROUP: RegisteredGroup = {
  name: 'Jarvis Worker 1',
  folder: 'jarvis-worker-1',
  trigger: '@jarvis',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  containerConfig: {
    model: 'claude-sonnet-4-6',
    timeout: 120_000,
  },
};

const PROMPT = `[jarvis-worker-1 e2e test]

Task: Print your worker identity and confirm GitHub CLI is available.

Steps:
1. Echo your worker ID from CLAUDE.md
2. Run: gh --version
3. Run: echo "GITHUB_TOKEN is set: $([[ -n $GITHUB_TOKEN ]] && echo YES || echo NO)"
4. Reply with the results in plain text.

Keep it brief.`;

async function main() {
  console.log('=== Jarvis Worker E2E Test ===');
  console.log(`Prompt: ${PROMPT.slice(0, 80)}...`);
  console.log('');

  const startMs = Date.now();
  let outputReceived = false;

  const output = await runContainerAgent(
    WORKER_GROUP,
    {
      prompt: PROMPT,
      groupFolder: 'jarvis-worker-1',
      chatJid: 'test@e2e',
      isMain: false,
      runId: `e2e-test-${Date.now()}`,
    },
    (_proc: ChildProcess, containerName: string) => {
      console.log(`Container started: ${containerName}`);
    },
    async (result) => {
      if (result.result) {
        outputReceived = true;
        console.log('\n--- Agent Output ---');
        console.log(result.result);
        if (result.usage) {
          const u = result.usage;
          console.log(`\n--- Usage ---`);
          console.log(`  input_tokens:  ${u.input_tokens}`);
          console.log(`  output_tokens: ${u.output_tokens}`);
          console.log(`  duration_ms:   ${u.duration_ms}`);
          console.log(`  peak_rss_mb:   ${u.peak_rss_mb}`);
        }
      }
    },
  );

  const durationMs = Date.now() - startMs;
  console.log('\n--- Final Result ---');
  console.log(`  status:       ${output.status}`);
  console.log(`  outputSent:   ${outputReceived}`);
  console.log(`  duration:     ${(durationMs / 1000).toFixed(1)}s`);
  if (output.error) console.log(`  error:        ${output.error}`);

  if (!outputReceived || output.status === 'error') {
    console.error('\nFAIL: no output or error status');
    process.exit(1);
  }

  console.log('\nPASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
