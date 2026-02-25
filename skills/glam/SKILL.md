---
name: glam
description: "Solana vault management via GLAM Protocol. Triggers: glam, glam-cli, glam-sdk, vault create/manage, tokenized vault, share class, DeFi vault, treasury, asset management, access control, delegate permissions, Jupiter swap, Drift perpetuals/spot/vaults, Kamino lending/borrow/vaults/farms, staking (Marinade/native/SPL/Sanctum/LST), cross-chain USDC (CCTP), timelock, subscription/redemption, NAV pricing, token transfer. Supports CLI and TypeScript SDK."
---

# GLAM Protocol Skill

GLAM provides programmable investment infrastructure on Solana: vaults with access control, DeFi integrations, and tokenization.

## Quick Start

```bash
# Install CLI
npm install -g @glamsystems/glam-cli

# Configure (~/.config/glam/config.json)
cat > ~/.config/glam/config.json << 'EOF'
{
  "keypair_path": "~/.config/solana/id.json",
  "json_rpc_url": "https://api.mainnet-beta.solana.com"
}
EOF

# Create vault, set active, enable integrations, verify
glam-cli vault create ./vault-template.json
glam-cli vault set <VAULT_STATE_PUBKEY>
glam-cli integration enable JupiterSwap KaminoLend
glam-cli vault view
```

## Critical: Integration Enablement

**You MUST enable integrations BEFORE using them.** This is the most common error.

Available: `JupiterSwap`, `DriftProtocol`, `KaminoLend`, `KaminoVaults`, `KaminoFarms`, `DriftVaults`, `SplToken`, `CCTP`, `GlamMint`, `Marinade` (staging), `StakePool` (staging), `SanctumSingle` (staging), `SanctumMulti` (staging), `StakeProgram` (staging).

Staging integrations require `--bypass-warning`.

---

## Workflows

### Tokenized Vault Setup

```bash
glam-cli vault create ./tokenized-vault-template.json
glam-cli vault set <VAULT_STATE_PUBKEY>
glam-cli integration enable JupiterSwap DriftProtocol KaminoLend
glam-cli manage price                          # Set initial NAV price
glam-cli jupiter set-max-slippage 100          # Configure swap policy

# Optional: delegate trading permissions (protocol-scoped)
glam-cli delegate grant <TRADER_PUBKEY> SwapAny --protocol JupiterSwap
glam-cli delegate grant <TRADER_PUBKEY> Deposit Withdraw CreateModifyOrders CancelOrders --protocol DriftProtocol

# Optional: set timelock (24 hours)
glam-cli timelock set 86400
```

### Drift Trading

```bash
glam-cli integration enable DriftProtocol
glam-cli drift-protocol init-user              # Required once
glam-cli drift-protocol deposit 0 1000         # Deposit USDC collateral
glam-cli drift-protocol perp long 0 1 0        # Open position
```

### Kamino Lending

```bash
glam-cli integration enable KaminoLend
glam-cli kamino-lend init                      # Required once
glam-cli kamino-lend deposit \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  1000
```

---

## Decision Tree

| Goal                | Integration          | Command                                                                                     |
|---------------------| -------------------- | ------------------------------------------------------------------------------------------- |
| Swap tokens         | `JupiterSwap`        | `jupiter swap`                                                                              |
| Lend for yield      | `KaminoLend`         | `kamino-lend deposit`                                                                       |
| Stake SOL (liquid)  | `Marinade` (staging)                                      | `marinade --bypass-warning stake`                                                           |
| Stake SOL (LST)     | `StakePool` / `SanctumSingle` / `SanctumMulti` (staging) | `lst --bypass-warning stake <pool> <amount>`                                                |
| Stake SOL (native)  | `StakeProgram` (staging)                                  | `stake --bypass-warning list / deactivate / withdraw`                                       |
| Kamino vaults       | `KaminoVaults`       | `kamino-vaults deposit`                                                                     |
| Drift vaults        | `DriftVaults`        | `drift-vaults deposit`                                                                      |
| Trade perps         | `DriftProtocol`      | `drift-protocol init-user` → `deposit` → `perp`                                             |
| Trade spot          | `DriftProtocol`      | `drift-protocol init-user` → `deposit` → `spot`                                             |
| Tokenized vault     | —                    | `vault create` → `manage price` → investors `invest subscribe`                              |
| Manage share tokens | —                    | SDK only: `client.mint.*` (freeze, issue, burn, forceTransfer)                              |
| Bridge USDC         | `CCTP`               | `cctp bridge-usdc <amount> <domain> <dest>` (0=ETH, 1=AVAX, 2=OP, 3=ARB, 6=BASE, 7=POLYGON) |
| Timelock            | —                    | `timelock set <seconds>`                                                                    |

---

## Common Errors

| Error                      | Solution                                               |
| -------------------------- | ------------------------------------------------------ |
| "Signer is not authorized" | Check `vault view` for owner; grant delegate if needed |
| "Integration not enabled"  | `integration enable <NAME>`                            |
| "Asset not in allowlist"   | `vault allowlist-asset <MINT>`                         |
| "User not initialized"     | `drift-protocol init-user` or `kamino-lend init`       |
| "No route found"           | Try smaller amount; check token liquidity              |
| "Slippage exceeded"        | Increase `--slippage-bps` or reduce amount             |
| "Insufficient collateral"  | `drift-protocol deposit` more                          |
| "Account is frozen"        | SDK: `client.mint.setTokenAccountsStates()`            |
| "Missing jupiter_api_key"  | Add `jupiter_api_key` to config.json                   |

> See [troubleshooting](./docs/troubleshooting.md) for detailed solutions.

---

## Common Mints

| Token   | Address                                        |
| ------- | ---------------------------------------------- |
| SOL     | `So11111111111111111111111111111111111111112`  |
| USDC    | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT    | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| mSOL    | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So`  |
| jitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |

---

## SDK Quick Start

```typescript
import {
  GlamClient,
  WSOL,
  USDC,
  getProgramAndBitflagByProtocolName,
} from "@glamsystems/glam-sdk";
import { BN } from "@coral-xyz/anchor";

const client = new GlamClient({ wallet });

// Create vault
const { vaultPda } = await client.vault.create({
  name: "My Vault",
  assets: [WSOL, USDC],
});

// Enable Jupiter integration
const perms = getProgramAndBitflagByProtocolName();
const [program, bitflag] = perms["JupiterSwap"];
await client.access.enableProtocols(vaultPda, program, parseInt(bitflag, 2));

// Swap
await client.jupiterSwap.swap(vaultPda, {
  inputMint: USDC,
  outputMint: WSOL,
  amount: new BN(100_000_000),
  slippageBps: 50,
});
```

---

## Reference

- **CLI**: [vault](./resources/cli/vault.md), [delegate](./resources/cli/delegate.md), [jupiter](./resources/cli/jupiter.md), [drift-protocol](./resources/cli/drift-protocol.md), [kamino-lend](./resources/cli/kamino-lend.md), [kamino-vaults](./resources/cli/kamino-vaults.md), [kamino-farms](./resources/cli/kamino-farms.md), [drift-vaults](./resources/cli/drift-vaults.md), [staking](./resources/cli/staking.md), [lst](./resources/cli/lst.md), [invest](./resources/cli/invest.md), [manage](./resources/cli/manage.md), [transfer](./resources/cli/transfer.md), [advanced](./resources/cli/advanced.md), [alt](./resources/cli/alt.md)
- **SDK**: [client](./resources/sdk/client.md), [integrations](./resources/sdk/integrations.md), [mint](./resources/sdk/mint.md), [multisig](./resources/sdk/multisig.md)
- **Other**: [concepts](./resources/concepts.md), [examples](./examples/EXAMPLES.md), [troubleshooting](./docs/troubleshooting.md)
- **Docs**: https://docs.glam.systems/
