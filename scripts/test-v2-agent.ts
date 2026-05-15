/**
 * Compatibility wrapper for the maintained v2 agent-runner test suite.
 *
 * The old version of this script created a single WAL-mode session.db, which
 * no longer matches v2. Sessions now use inbound.db + outbound.db under
 * data/v2-sessions/<agent_group_id>/<session_id>/.
 *
 * Usage: pnpm exec tsx scripts/test-v2-agent.ts
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const result = spawnSync('pnpm', ['run', 'test:container'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
