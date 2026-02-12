/**
 * Sprites Provisioning for NanoClaw
 * Handles first-time setup of a Sprite: installing bun, claude-code,
 * agent-browser dependencies, chromium, gh CLI, and workspace dirs.
 */

import { logger } from '../logger.js';

// The Sprites SDK uses the same exec/spawn pattern as Node child_process
type SpriteHandle = {
  exec(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
};

const PROVISION_MARKER = '/workspace/.nanoclaw-provisioned';

/**
 * Check if a Sprite has already been provisioned.
 */
export async function isProvisioned(sprite: SpriteHandle): Promise<boolean> {
  try {
    await sprite.exec(`test -f ${PROVISION_MARKER}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Provision a Sprite with all dependencies needed to run NanoClaw agent-runner.
 * This is idempotent — skips if already provisioned.
 */
export async function provisionSprite(sprite: SpriteHandle, spriteName: string): Promise<void> {
  if (await isProvisioned(sprite)) {
    logger.info({ sprite: spriteName }, 'Sprite already provisioned, skipping');
    return;
  }

  logger.info({ sprite: spriteName }, 'Provisioning Sprite (first-time setup)...');

  // Install bun
  logger.info({ sprite: spriteName }, 'Installing bun...');
  await sprite.exec('curl -fsSL https://bun.sh/install | bash', { timeout: 120_000 });
  // Ensure bun is on PATH for subsequent commands
  await sprite.exec('echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc');

  // Install Claude Code globally
  logger.info({ sprite: spriteName }, 'Installing Claude Code...');
  await sprite.exec('export PATH="$HOME/.bun/bin:$PATH" && bun install -g @anthropic-ai/claude-code', { timeout: 180_000 });

  // Install gh CLI
  logger.info({ sprite: spriteName }, 'Installing gh CLI...');
  await sprite.exec(
    '(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) && ' +
    'sudo mkdir -p -m 755 /etc/apt/keyrings && ' +
    'out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && ' +
    'cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && ' +
    'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && ' +
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && ' +
    'sudo apt update && sudo apt install gh -y',
    { timeout: 180_000 },
  );

  // Install chromium for agent-browser
  logger.info({ sprite: spriteName }, 'Installing chromium...');
  await sprite.exec('sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium', { timeout: 120_000 });

  // Create workspace directories
  await sprite.exec('mkdir -p /workspace/group /workspace/global /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/env-dir /workspace/shared');

  // Create /app directory for agent-runner
  await sprite.exec('mkdir -p /app/src');

  // Create Claude config directory
  await sprite.exec('mkdir -p /home/user/.claude');

  // Write provision marker
  await sprite.exec(`echo "provisioned=$(date -Iseconds)" > ${PROVISION_MARKER}`);

  logger.info({ sprite: spriteName }, 'Sprite provisioning complete');
}
