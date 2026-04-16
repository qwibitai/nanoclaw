import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

export interface AgentRunnerBuildResult {
  entryPoint: string;
  /** Error message if compile failed; null on success. */
  error: string | null;
}

/**
 * Ensure the agent-runner TypeScript sources are compiled to JS. Skips
 * the `tsc` invocation if every source file is already older than the
 * dist entry point.
 */
export function ensureAgentRunnerBuilt(
  projectRoot: string,
): AgentRunnerBuildResult {
  const agentRunnerPkg = path.join(projectRoot, 'container', 'agent-runner');
  const buildDir = path.join(agentRunnerPkg, 'dist');
  fs.mkdirSync(buildDir, { recursive: true });

  const tsconfigPath = path.join(agentRunnerPkg, 'tsconfig.json');
  const entryPoint = path.join(buildDir, 'index.js');
  const agentRunnerSrcDir = path.join(agentRunnerPkg, 'src');

  let srcMtime = 0;
  if (fs.existsSync(agentRunnerSrcDir)) {
    for (const f of fs.readdirSync(agentRunnerSrcDir)) {
      if (
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.d.ts')
      ) {
        const mt = fs.statSync(path.join(agentRunnerSrcDir, f)).mtimeMs;
        if (mt > srcMtime) srcMtime = mt;
      }
    }
  }
  const distMtime = fs.existsSync(entryPoint)
    ? fs.statSync(entryPoint).mtimeMs
    : 0;

  if (srcMtime <= distMtime) {
    return { entryPoint, error: null };
  }

  try {
    const npxPath = path.join(path.dirname(process.execPath), 'npx');
    execSync(`${npxPath} tsc --project ${tsconfigPath}`, {
      cwd: agentRunnerPkg,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
      },
    });
    return { entryPoint, error: null };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.error({ err }, 'Failed to compile agent-runner');
    return {
      entryPoint,
      error: `Failed to compile agent-runner: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
