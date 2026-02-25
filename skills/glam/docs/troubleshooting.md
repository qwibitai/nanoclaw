# GLAM Troubleshooting

## Installation

| Error                                        | Solution                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `EACCES: permission denied` (npm install)    | Use `npx @glamsystems/glam-cli` instead, or fix npm prefix: `npm config set prefix ~/.npm-global` |
| `Cannot find module '@glamsystems/glam-sdk'` | Install peer deps: `npm install @solana/web3.js @coral-xyz/anchor`                                |

## Configuration

Config file: `~/.config/glam/config.json`

```json
{
  "keypair_path": "~/.config/solana/id.json",
  "json_rpc_url": "https://api.mainnet-beta.solana.com"
}
```

| Error                                                      | Solution                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Keypair file not found` / `keypairPath is not configured` | Create config file above. Create keypair if needed: `solana-keygen new` |
| `Invalid secret key`                                       | Keypair must be JSON array of 64 numbers: `[123,45,67,...]`             |

## Transactions

| Error                                                               | Solution                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Attempt to debit an account but found no record of a prior credit` | Check `solana balance` and `glam-cli vault token-balances`                |
| `Transaction simulation failed`                                     | Verify integration is enabled: `glam-cli vault view`                      |
| `Transaction was not confirmed or block height exceeded/expired`    | Check if transaction is landed. Retry, or switch to a faster RPC endpoint |
| `exceeded CUs meter at BPF instruction`                             | SDK: pass `{ computeUnitLimit: 400_000 }` as options                      |

## Permissions

| Error                                        | Solution                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Signer is not authorized`                   | 1) Check you're using vault owner's keypair (`glam-cli vault view`) 2) Grant delegate permission 3) Enable integration |
| `Delegate does not have required permission` | `glam-cli delegate list` to check, then `glam-cli delegate grant <PUBKEY> <PERMS> --protocol <PROTO>`                  |
| `Asset not in vault allowlist`               | `glam-cli vault allowlist-asset <MINT> --yes`                                                                          |

## RPC

| Error                    | Solution                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `429 Too Many Requests`  | Switch to a paid RPC endpoint in config                                                                   |
| `Connection refused`     | Check RPC URL: `glam-cli env`                                                                             |
| `Account does not exist` | Wrong vault address, vault closed, or wrong cluster. Verify with `glam-cli vault view` and `glam-cli env` |

## Integration-Specific

### Jupiter

| Error                         | Solution                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `No route found for swap`     | Try smaller amount; check `glam-cli jupiter view-policy` for allowlisted tokens |
| `Slippage tolerance exceeded` | Increase: `--slippage-bps 100` (1%), or reduce trade size                       |

### Drift

| Error                                  | Solution                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `Drift user account not found`         | `glam-cli drift-protocol init-user --yes` (required once)                        |
| `Insufficient collateral for position` | `glam-cli drift-protocol deposit <market_id> <amount> --yes`, or reduce position |

### Kamino

| Error                          | Solution                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `Lending market not found`     | Use correct market address (Main: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`) |
| `Obligation account not found` | `glam-cli kamino-lend init --yes` (required once)                                 |

## Getting Help

1. Check vault state: `glam-cli vault view`
2. GitHub issues: https://github.com/glamsystems/glam-cli/issues
