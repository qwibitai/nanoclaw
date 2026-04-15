import { execFileSync } from 'child_process';

const sessionName = `nanoclaw-smoke-${process.pid}-${Date.now()}`;

function runTmux(args) {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  const version = runTmux(['-V']);
  console.log(version);

  runTmux(['new-session', '-d', '-s', sessionName, 'sleep 30']);
  runTmux(['has-session', '-t', sessionName]);
  runTmux(['kill-session', '-t', sessionName]);

  let sessionStillExists = false;
  try {
    runTmux(['has-session', '-t', sessionName]);
    sessionStillExists = true;
  } catch {
    sessionStillExists = false;
  }

  if (sessionStillExists) {
    throw new Error(`tmux session ${sessionName} still exists after kill`);
  }

  console.log(`tmux runtime smoke passed (${sessionName})`);
} finally {
  try {
    runTmux(['kill-session', '-t', sessionName]);
  } catch {
    // already cleaned up
  }
}
