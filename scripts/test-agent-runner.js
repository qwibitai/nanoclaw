import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = process.cwd();
const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
const nodeModulesDir = path.join(agentRunnerDir, 'node_modules');
const packageLock = path.join(agentRunnerDir, 'package-lock.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args) {
  execFileSync(npmCmd, args, { cwd: agentRunnerDir, stdio: 'inherit' });
}

if (!existsSync(nodeModulesDir)) {
  if (process.env.CI && existsSync(packageLock)) {
    runNpm(['ci']);
  } else {
    runNpm(['install']);
  }
}

runNpm(['run', 'build']);
