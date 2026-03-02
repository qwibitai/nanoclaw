#!/usr/bin/env node

/**
 * codex-oauth CLI
 *
 * Usage:
 *   codex-oauth login     - Authenticate with ChatGPT
 *   codex-oauth status    - Show auth status
 *   codex-oauth logout    - Clear stored tokens
 *   codex-oauth chat <msg> - Send a quick message
 */

import { CodexAuth } from './auth.js';
import { CodexClient } from './client.js';

const auth = new CodexAuth();

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'login': {
      console.log('Starting OAuth flow...');
      const tokens = await auth.login();
      console.log(`\nAuthenticated!`);
      console.log(`  Account ID: ${tokens.account_id.slice(0, 8)}...`);
      console.log(`  Token expires: ${new Date(tokens.expires_at).toLocaleString()}`);
      break;
    }

    case 'status': {
      const tokens = auth.getTokensSync();
      if (!tokens) {
        console.log('Not authenticated. Run: codex-oauth login');
        process.exit(1);
      }
      const expired = Date.now() >= tokens.expires_at;
      console.log(`Authenticated`);
      console.log(`  Account ID: ${tokens.account_id.slice(0, 8)}...`);
      console.log(`  Token expires: ${new Date(tokens.expires_at).toLocaleString()}`);
      console.log(`  Status: ${expired ? 'expired (will auto-refresh)' : 'valid'}`);
      break;
    }

    case 'logout': {
      await auth.logout();
      console.log('Logged out. Tokens cleared.');
      break;
    }

    case 'chat': {
      const message = process.argv.slice(3).join(' ');
      if (!message) {
        console.error('Usage: codex-oauth chat <message>');
        process.exit(1);
      }
      if (!auth.isAuthenticated()) {
        console.error('Not authenticated. Run: codex-oauth login');
        process.exit(1);
      }
      const client = new CodexClient(auth);
      const response = await client.chat(message);
      console.log(response);
      break;
    }

    default: {
      console.log(`codex-oauth - OAuth PKCE auth for OpenAI Codex

Usage:
  codex-oauth login         Authenticate with ChatGPT
  codex-oauth status        Show authentication status
  codex-oauth logout        Clear stored tokens
  codex-oauth chat <msg>    Send a message to Codex`);
      if (command && command !== 'help' && command !== '--help' && command !== '-h') {
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
