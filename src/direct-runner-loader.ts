/**
 * Direct runner loader — preload module that registers resolution hooks.
 * Usage: node --import ./dist/direct-runner-loader.js dist/index.js
 *
 * Does nothing unless NANOCLAW_DIRECT_RUNNER=1 is set.
 * Zero changes to any upstream source file.
 */
import { register } from 'node:module';

if (process.env.NANOCLAW_DIRECT_RUNNER === '1') {
  register('./direct-runner-hooks.js', import.meta.url);
}
