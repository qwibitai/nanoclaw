/**
 * NanoClaw Agent Runner — Entry point
 * Dispatches to claude-runner or cursor-runner based on AGENT_BACKEND env var.
 *
 * Input protocol:  Stdin: ContainerInput JSON
 * Output protocol: Stdout: OUTPUT_START...OUTPUT_END marker pairs
 */

const backend = process.env.AGENT_BACKEND ?? 'claude';
console.error(`[agent-runner] AGENT_BACKEND=${backend}`);

if (backend === 'cursor') {
  const { main } = await import('./cursor-runner.js');
  await main();
} else {
  const { main } = await import('./claude-runner.js');
  await main();
}
