# CLI: Vault Commands

## Configuration

The GLAM CLI uses a JSON configuration file.

### Config File Location

- **Default**: `~/.config/glam/config.json`
- **Docker**: `/workspace/config.json`
- **Override**: Use `-C, --config <path>` flag

### Config File Format

```json
{
  "keypair_path": "~/.config/solana/id.json",
  "json_rpc_url": "https://api.mainnet-beta.solana.com",
  "tx_rpc_url": "https://api.mainnet-beta.solana.com",
  "cluster": "mainnet-beta",
  "priority_fee": { "micro_lamports": 10000 },
  "jupiter_api_key": "your-api-key",
  "websocket_disabled": false,
  "glam_staging": false,
  "glam_state": "optional-default-vault-state-pubkey"
}
```

**Config options:**

| Key                  | Required | Description                                     |
| -------------------- | -------- | ----------------------------------------------- |
| `keypair_path`       | Yes      | Path to keypair JSON file                       |
| `json_rpc_url`       | Yes      | Solana JSON RPC endpoint                        |
| `cluster`            | Yes      | `mainnet-beta`, `devnet`, or `localnet`         |
| `tx_rpc_url`         | No       | Separate RPC for landing transactions           |
| `jupiter_api_key`    | Yes      | Jupiter API key                                 |
| `priority_fee`       | No       | Priority fee config object (see below)          |
| `websocket_disabled` | No       | Set `true` to disable WebSocket methods         |
| `glam_staging`       | No       | Set `true` to use GLAM mainnet staging programs |
| `glam_state`         | No       | Default active vault state pubkey               |

**Static priority fee:**

```json
{ "priority_fee": { "micro_lamports": 10000 } }
```

**Dynamic priority fee:**

```json
{ "priority_fee": { "level": "Medium", "helius_api_key": "your-helius-key" } }
```

Levels: `Min`, `Low`, `Medium`, `High`, `VeryHigh`, `UnsafeMax`, `Default` (mainnet-beta only).

### `glam-cli env`

Display current configuration.

```bash
glam-cli env
```

**Output shows:** keypair path, RPC URLs, cluster, priority fee, and other configured values.

---

## Vault Commands

### `glam-cli vault set`

Set the active vault for all subsequent commands.

```bash
glam-cli vault set <state>
```

This sets the `glam_state` in your config. All commands that operate on a vault will use this active vault unless overridden.

### `glam-cli vault create`

Create a new vault from a JSON template.

```bash
glam-cli vault create <path-to-template.json>
```

**Example:**

```bash
glam-cli vault create ./vault-template.json
```

**JSON template format:**

```json
{
  "state": {
    "accountType": "tokenizedVault",
    "name": "My Fund",
    "enabled": true,
    "baseAssetMint": "So11111111111111111111111111111111111111112",
    "assets": ["So11111111111111111111111111111111111111112"]
  },
  "mint": {
    "name": "Fund Shares",
    "symbol": "FUND",
    "maxCap": 1000000000000,
    "minSubscription": 1000000000,
    "minRedemption": 100000000,
    "lockupPeriod": 0,
    "feeStructure": {
      "vault": { "subscriptionFeeBps": 10, "redemptionFeeBps": 10 },
      "manager": { "subscriptionFeeBps": 0, "redemptionFeeBps": 0 },
      "management": { "feeBps": 100 },
      "performance": {
        "feeBps": 2000,
        "hurdleRateBps": 500,
        "hurdleType": "hard"
      }
    },
    "notifyAndSettle": {
      "model": "continuous",
      "permissionlessFulfillment": false,
      "subscribeNoticePeriodType": "hard",
      "subscribeNoticePeriod": 0,
      "subscribeSettlementPeriod": 0,
      "subscribeCancellationWindow": 0,
      "redeemNoticePeriodType": "hard",
      "redeemNoticePeriod": 0,
      "redeemSettlementPeriod": 0,
      "redeemCancellationWindow": 0,
      "timeUnit": "slot"
    }
  }
}
```

### `glam-cli vault view`

View vault details.

```bash
glam-cli vault view [state] [--compact]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-c, --compact` | Compact JSON output (no indentation) |

### `glam-cli vault list`

List vaults owned by configured keypair.

```bash
glam-cli vault list [OPTIONS]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-a, --all` | List all vaults (not just owned) |
| `-o, --owner-only` | List only vaults where signer is owner |
| `-t, --type <TYPE>` | Filter by type (`vault` or `tokenizedVault`) |

### `glam-cli vault token-balances`

Show vault token balances.

```bash
glam-cli vault token-balances [--all] [--json]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-a, --all` | Show all assets including zero-balance accounts |
| `-j, --json` | Output in JSON format |

### `glam-cli vault holdings`

Show vault holdings with USD values.

```bash
glam-cli vault holdings
```

### `glam-cli vault wrap` / `glam-cli vault unwrap`

Wrap/unwrap SOL to wSOL in vault.

```bash
glam-cli vault wrap <amount> [--yes]
glam-cli vault unwrap [--yes]
```

### `glam-cli vault allowlist-asset`

Add asset to vault allowlist.

```bash
glam-cli vault allowlist-asset <asset> [--yes]
```

### `glam-cli vault list-assets`

List assets in vault allowlist.

```bash
glam-cli vault list-assets
```

### `glam-cli vault remove-asset`

Remove asset from vault allowlist.

```bash
glam-cli vault remove-asset <asset> [--yes]
```

### `glam-cli vault update-owner`

Transfer vault ownership to a new owner.

```bash
glam-cli vault update-owner <new_owner> [--name <name>] [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-n, --name <NAME>` | New portfolio manager name |
| `-y, --yes` | Skip confirmation prompt |

### `glam-cli vault enable` / `glam-cli vault disable`

Enable or disable the vault.

```bash
glam-cli vault enable [--yes]
glam-cli vault disable [--yes]
```

### `glam-cli vault extend`

Extend vault state account size (for additional data storage).

```bash
glam-cli vault extend <bytes> [--yes]
```

### `glam-cli vault close-token-accounts`

Close vault token accounts (reclaim rent).

```bash
glam-cli vault close-token-accounts [mints...] [--empty] [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--empty` | Close all zero-balance token accounts |
| `-y, --yes` | Skip confirmation prompt |

Provide specific mint address(es) to close those accounts, or use `--empty` to close all empty ones.

### `glam-cli vault close`

Close a vault (must be empty).

```bash
glam-cli vault close [state] [--yes]
```

---

## Integration Commands

### `glam-cli integration list`

List available integrations.

```bash
glam-cli integration list
```

**Available integrations:**

- `SystemProgram` - SOL wrapping and transfers
- `JupiterSwap` - Token swaps via Jupiter aggregator
- `DriftProtocol` - Perpetuals and spot trading
- `DriftVaults` - Drift managed vaults
- `KaminoLend` - Lending and borrowing
- `KaminoVaults` - Kamino vaults
- `KaminoFarms` - Kamino farming
- `SplToken` - SPL token transfers
- `CCTP` - Cross-chain USDC transfers
- `GlamMint` - Share class token operations
- `Marinade` - Marinade liquid staking (staging)
- `StakeProgram` - Native SOL staking (staging)
- `StakePool` - SPL stake pools (staging)
- `SanctumSingle` - Sanctum single-validator pools (staging)
- `SanctumMulti` - Sanctum multi-validator pools (staging)

### `glam-cli integration enable`

Enable integrations for the active vault.

```bash
glam-cli integration enable <integration>...
```

Integration names support fuzzy matching (case-insensitive, typo suggestions).

**Examples:**

```bash
# Enable single integration
glam-cli integration enable JupiterSwap

# Enable multiple integrations
glam-cli integration enable JupiterSwap DriftProtocol KaminoLend

# Case-insensitive matching works
glam-cli integration enable jupiterswap
```

### `glam-cli integration disable`

Disable an integration.

```bash
glam-cli integration disable <integration>
```

### `glam-cli integration disable-all`

Disable all protocols for an integration program.

```bash
glam-cli integration disable-all <integration_program>
```

---

## Global Options

These options apply to all commands:

| Flag                    | Description                 |
| ----------------------- | --------------------------- |
| `-C, --config <PATH>`   | Override config file path   |
| `-S, --skip-simulation` | Skip transaction simulation |
