/**
 * Reauth orchestrator — generic, no per-service knowledge.
 * Builds a menu from all registered providers, runs selected option,
 * stores result via the owning provider.
 */
import { logger } from '../logger.js';
import { getAllProviders } from './registry.js';
import { execInContainer, authSessionDir } from './exec.js';
import type { AuthContext, AuthExecOpts, AuthOption, ChatIO, ExecHandle } from './types.js';

/** Prefix for all scripted reauth messages. */
const REAUTH_PREFIX = '🔑🤖';

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
    await chat.send(`${REAUTH_PREFIX} No auth providers registered.`);
    return false;
  }

  // Build numbered menu — each option separated by blank line
  const optionBlocks: string[] = [];
  for (let i = 0; i < allOptions.length; i++) {
    const opt = allOptions[i];
    let block = `${i + 1}. *${opt.label}*`;
    if (opt.description) {
      block += `\n   ${opt.description}`;
    }
    optionBlocks.push(block);
  }
  optionBlocks.push(`${allOptions.length + 1}. Cancel`);

  const scopeNote = scope === 'default'
    ? '⚠️ This will change the *default* credentials used by all groups that don\'t have their own.'
    : `Group: *${scope}*`;

  await chat.send(
    [
      `${REAUTH_PREFIX} *Authentication required*`,
      ``,
      scopeNote,
      `Reason: ${reason}`,
      ``,
      `Choose an authentication method:`,
      ``,
      ...optionBlocks.flatMap((block, i) =>
        i === 0 ? [block] : ['', block],
      ),
      ``,
      `_Scripted dialog — reply with a number only._`,
    ].join('\n'),
  );

  const reply = await chat.receive(120_000);
  if (!reply) {
    await chat.send(`${REAUTH_PREFIX} Timed out. Skipping authentication.`);
    return false;
  }
  chat.advanceCursor();

  const choice = parseInt(reply.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > allOptions.length) {
    await chat.send(`${REAUTH_PREFIX} Cancelled.`);
    return false;
  }

  const selected = allOptions[choice - 1];
  const sessionDir = authSessionDir(scope);

  const ctx: AuthContext = {
    scope,
    exec(command: string[], opts?: AuthExecOpts): ExecHandle {
      return execInContainer(command, sessionDir, {
        mounts: opts?.mounts,
      });
    },
    chat: prefixedChat(chat),
  };

  try {
    const result = await selected.run(ctx);
    if (!result) {
      await chat.send(`${REAUTH_PREFIX} Auth flow cancelled or failed.`);
      return false;
    }

    selected.provider.storeResult(scope, result);
    await chat.send(`${REAUTH_PREFIX} Credentials stored for ${selected.provider.displayName}.`);
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
    await chat.send(`${REAUTH_PREFIX} Auth flow error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Wrap a ChatIO so all outgoing messages get the reauth prefix. */
function prefixedChat(chat: ChatIO): ChatIO {
  return {
    send: (text: string) => chat.send(`${REAUTH_PREFIX} ${text}`),
    receive: (timeoutMs?: number) => chat.receive(timeoutMs),
    advanceCursor: () => chat.advanceCursor(),
  };
}
