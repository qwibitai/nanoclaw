#!/usr/bin/env tsx
/**
 * Paraclaw — Parachute integration CLI.
 *
 *   pnpm run parachute attach-vault <group> --token pvt_… [--scope vault:read] [--vault-url URL]
 *   pnpm run parachute detach-vault <group> [--name parachute-vault]
 *   pnpm run parachute status [<group>]
 *
 * Wires (or unwires) a Parachute Vault as an HTTP MCP server in the named
 * agent group's `container.json`, and records the attachment metadata in a
 * sibling `parachute.json` for visibility / future tooling.
 *
 * The CLI does NOT mint vault tokens — that's the user's job, via:
 *
 *   parachute vault tokens create --scope vault:read --label claw-<group>
 *
 * Once you have a `pvt_…` token, paste it here. Detach also doesn't revoke
 * tokens — see vault-mcp.ts comments for why (one-way op; deliberate).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';
import {
  DEFAULT_VAULT_MCP_NAME,
  attachVaultToGroup,
  detachVaultFromGroup,
  readVaultAttachment,
} from '../src/parachute/vault-mcp.js';
import type { VaultScope } from '../src/parachute/types.js';

const SUBCOMMANDS = ['attach-vault', 'detach-vault', 'status'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(exit = 0): never {
  console.error(`usage:
  pnpm run parachute attach-vault <group> --token <pvt_...> [--scope vault:read|vault:write|vault:admin]
                                          [--vault-url http://127.0.0.1:1940/vault/default]
                                          [--label <token-label>] [--name <mcp-name>]
  pnpm run parachute detach-vault <group> [--name parachute-vault]
  pnpm run parachute status [<group>]

Notes:
  - Mint a token with: parachute vault tokens create --scope vault:read --label claw-<group>
  - --vault-url defaults to http://127.0.0.1:1940/vault/default
  - --scope defaults to vault:read (the safest default; granted scope is recorded only)
  - --name defaults to '${DEFAULT_VAULT_MCP_NAME}' (the key under mcpServers)
`);
  process.exit(exit);
}

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseScope(s: string | undefined): VaultScope {
  const allowed: VaultScope[] = ['vault:read', 'vault:write', 'vault:admin'];
  if (!s) return 'vault:read';
  if ((allowed as string[]).includes(s)) return s as VaultScope;
  console.error(`unrecognized scope "${s}". Allowed: ${allowed.join(', ')}`);
  process.exit(2);
}

function listGroupFolders(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function main(): void {
  const [, , raw, ...rest] = process.argv;
  if (!raw || raw === '--help' || raw === '-h') usage(0);
  if (!(SUBCOMMANDS as readonly string[]).includes(raw)) {
    console.error(`unknown subcommand: ${raw}\n`);
    usage(2);
  }
  const sub = raw as Subcommand;

  if (sub === 'attach-vault') {
    const group = rest[0];
    if (!group) {
      console.error('attach-vault requires <group> as the first positional argument.');
      usage(2);
    }
    const token = arg('token', rest);
    if (!token) {
      console.error('attach-vault requires --token <pvt_...>');
      usage(2);
    }
    const vaultBaseUrl = arg('vault-url', rest) ?? 'http://127.0.0.1:1940/vault/default';
    const scope = parseScope(arg('scope', rest));
    const tokenLabel = arg('label', rest) ?? `claw-${group}`;
    const mcpName = arg('name', rest);

    attachVaultToGroup({
      folder: group,
      vaultBaseUrl,
      vaultToken: token,
      scope,
      tokenLabel,
      mcpName,
      instructions: `You have access to a Parachute Vault at ${vaultBaseUrl} via the \`${mcpName ?? DEFAULT_VAULT_MCP_NAME}\` MCP server. Scope: ${scope}. The vault is the user's open knowledge graph — notes, tags, links. Use it as you would any tool: query when you need context, write when you have something durable to capture. The user decides how their vault is organized; respect that.`,
    });

    console.log(`✓ vault attached to group "${group}"`);
    console.log(`  vault: ${vaultBaseUrl}`);
    console.log(`  scope: ${scope}`);
    console.log(`  token label: ${tokenLabel}  (revoke with: parachute vault tokens revoke ${tokenLabel})`);
    console.log(`  mcp name: ${mcpName ?? DEFAULT_VAULT_MCP_NAME}`);
    console.log('');
    console.log('Next: restart the agent\'s container so it picks up the new MCP entry.');
    console.log(`  (or just send the next message — NanoClaw spawns lazily on wake.)`);
    return;
  }

  if (sub === 'detach-vault') {
    const group = rest[0];
    if (!group) {
      console.error('detach-vault requires <group> as the first positional argument.');
      usage(2);
    }
    const mcpName = arg('name', rest) ?? DEFAULT_VAULT_MCP_NAME;
    detachVaultFromGroup(group, mcpName);
    console.log(`✓ vault detached from group "${group}" (mcp: ${mcpName})`);
    console.log(`  Token NOT revoked — run: parachute vault tokens revoke <label>`);
    return;
  }

  if (sub === 'status') {
    const target = rest[0];
    const groups = target ? [target] : listGroupFolders();
    if (groups.length === 0) {
      console.log('no agent groups found in', GROUPS_DIR);
      return;
    }
    let any = false;
    for (const g of groups) {
      const att = readVaultAttachment(g);
      if (!att) {
        if (target) console.log(`${g}: no vault attached`);
        continue;
      }
      any = true;
      console.log(`${g}:`);
      console.log(`  vault: ${att.vaultBaseUrl}`);
      console.log(`  scope: ${att.scope}`);
      console.log(`  token label: ${att.tokenLabel}`);
      console.log(`  attached: ${att.attachedAt}`);
    }
    if (!any && !target) console.log('no agent groups have a vault attached.');
    return;
  }
}

main();
