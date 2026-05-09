/**
 * Switch the agent provider for a group in one command.
 *
 * Thin CLI wrapper around `src/provider-switch.ts`. All the logic — touching
 * container.json, updating sessions.agent_provider, stopping running
 * containers — lives there so this script and the Telegram `/provider`
 * command share one implementation.
 *
 * Usage:
 *
 *   pnpm exec tsx scripts/switch-provider.ts <group-folder> <provider>
 *
 * Examples:
 *
 *   pnpm exec tsx scripts/switch-provider.ts telegram_main codex
 *   pnpm exec tsx scripts/switch-provider.ts telegram_main claude
 */
import { setProvider } from '../src/provider-switch.js';

function usage(): never {
  console.error('Usage: pnpm exec tsx scripts/switch-provider.ts <group-folder> <provider>');
  console.error('Example: pnpm exec tsx scripts/switch-provider.ts telegram_main codex');
  process.exit(1);
}

function main(): void {
  const [folder, provider] = process.argv.slice(2);
  if (!folder || !provider) usage();

  const result = setProvider(folder, provider);

  if (!result.ok) {
    switch (result.reason) {
      case 'no-change':
        console.log(`No change — ${folder} is already on ${provider}.`);
        return;
      case 'no-container-json':
        console.error(`No container.json for "${folder}" — is it a real group?`);
        process.exit(2);
        return;
      case 'group-not-found':
        console.error(`No agent_groups row matches folder "${folder}".`);
        process.exit(3);
        return;
      default:
        console.error(`Failed to switch (${result.reason ?? 'unknown reason'}).`);
        process.exit(4);
        return;
    }
  }

  console.log(`Switched ${folder}: ${result.previousProvider} → ${result.newProvider}`);
  console.log(`  container.json     updated`);
  console.log(`  sessions.agent_provider rows updated: ${result.sessionsUpdated ?? 0}`);
  console.log(`  containers stopped:  ${result.containersStopped ?? 0}`);
  console.log('');
  console.log('Next inbound message will respawn the container with the new provider.');
}

main();
