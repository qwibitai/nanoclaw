/**
 * Reauth orchestrator — generic, no per-service knowledge.
 * Builds a menu from all registered providers, runs selected option,
 * stores result via the owning provider.
 */
import { logger } from '../logger.js';
import { getAllProviders } from './registry.js';
import { execInContainer, authSessionDir } from './exec.js';
import type { AuthContext, AuthExecOpts, AuthOption, ChatIO, ExecHandle } from './types.js';

/**
 * Run the interactive reauth flow for a given scope.
 * Returns true if credentials were successfully obtained.
 */
export async function runReauth(
  scope: string,
  chat: ChatIO,
  reason: string,
): Promise<boolean> {
  const providers = getAllProviders();
  const allOptions: AuthOption[] = [];

  for (const provider of providers) {
    allOptions.push(...provider.authOptions(scope));
  }

  if (allOptions.length === 0) {
    await chat.send('No auth providers registered.');
    return false;
  }

  // Build numbered menu
  const lines = allOptions.map(
    (opt, i) => `${i + 1}. ${opt.label} — ${opt.provider.displayName}`,
  );
  lines.push(`${allOptions.length + 1}. Cancel`);

  await chat.send(
    [
      `⚠️ *Authentication required* (${scope})`,
      ``,
      `Reason: ${reason}`,
      ``,
      `Valid credentials are needed to process messages. This is a scripted dialog — reply with a number only:`,
      ``,
      ...lines,
    ].join('\n'),
  );

  const reply = await chat.receive(120_000);
  if (!reply) {
    await chat.send('Timed out. Skipping authentication.');
    return false;
  }

  const choice = parseInt(reply.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > allOptions.length) {
    await chat.send('Cancelled.');
    return false;
  }

  const selected = allOptions[choice - 1];
  const sessionDir = authSessionDir(scope);

  const ctx: AuthContext = {
    scope,
    exec(command: string[], opts?: AuthExecOpts): ExecHandle {
      return execInContainer(command, sessionDir, {
        extraMounts: opts?.extraMounts,
      });
    },
    chat,
  };

  try {
    const result = await selected.run(ctx);
    if (!result) {
      await chat.send('Auth flow cancelled or failed.');
      return false;
    }

    selected.provider.storeResult(scope, result);
    await chat.send(`Credentials stored for ${selected.provider.displayName}.`);
    logger.info(
      { scope, provider: selected.provider.service },
      'Reauth completed',
    );
    return true;
  } catch (err) {
    logger.error(
      { scope, provider: selected.provider.service, err },
      'Reauth flow error',
    );
    await chat.send(`Auth flow error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
