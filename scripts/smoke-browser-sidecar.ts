/**
 * Smoke test for Track D: verify waitForSidecarReady and ensureBrowserSidecar
 * against the already-running browser sidecar.
 */
import { BROWSER_CDP_URL } from '../src/config.js';
import { waitForSidecarReady } from '../src/browser/playwright-client.js';
import { ensureBrowserSidecar } from '../src/container-runtime.js';

async function main() {
  console.log(`[smoke] CDP URL: ${BROWSER_CDP_URL}`);

  console.log('[smoke] Test 1: waitForSidecarReady against live sidecar');
  const t0 = Date.now();
  const ready = await waitForSidecarReady(BROWSER_CDP_URL, {
    timeoutMs: 5000,
    intervalMs: 100,
  });
  console.log(`[smoke]   -> ready=${ready} (${Date.now() - t0}ms)`);
  if (!ready) throw new Error('sidecar is not reachable on ' + BROWSER_CDP_URL);

  console.log('[smoke] Test 2: waitForSidecarReady against bad URL');
  const t1 = Date.now();
  const notReady = await waitForSidecarReady('http://localhost:9999', {
    timeoutMs: 400,
    intervalMs: 100,
  });
  console.log(`[smoke]   -> ready=${notReady} (${Date.now() - t1}ms)`);
  if (notReady) throw new Error('expected false for bad URL');

  console.log('[smoke] Test 3: full ensureBrowserSidecar against live sidecar');
  const t2 = Date.now();
  await ensureBrowserSidecar();
  console.log(`[smoke]   -> completed in ${Date.now() - t2}ms (see pino logs above)`);

  console.log('[smoke] ALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exit(1);
});
