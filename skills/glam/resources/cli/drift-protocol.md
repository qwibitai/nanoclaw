# CLI: Drift Protocol Commands (`glam-cli drift-protocol`)

Perpetuals and spot trading via Drift Protocol.

**Prerequisite:** Enable `DriftProtocol` integration before using these commands.

```bash
glam-cli integration enable DriftProtocol
```

## Commands

### `glam-cli drift-protocol init-user`

Initialize Drift user account for vault. **Required before any Drift operations.**

```bash
glam-cli drift-protocol init-user [--sub-account-id <id>] [--pool-id <id>] [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--sub-account-id <ID>` | Sub-account ID (for multiple Drift accounts) |
| `--pool-id <ID>` | Pool ID to assign user to |
| `-y, --yes` | Skip confirmation prompt |

### `glam-cli drift-protocol deposit`

Deposit collateral to Drift.

```bash
glam-cli drift-protocol deposit <market_index> <amount> [--sub-account-id <id>] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `market_index` | Spot market index (0=USDC, 1=SOL, etc.) |
| `amount` | Amount to deposit |

### `glam-cli drift-protocol withdraw`

Withdraw collateral from Drift.

```bash
glam-cli drift-protocol withdraw <market_index> <amount> [--sub-account-id <id>] [--yes]
```

### `glam-cli drift-protocol spot`

Place spot market order.

```bash
glam-cli drift-protocol spot <direction> <market_index> <amount> <price_limit> [--sub-account-id <id>] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `direction` | `long` or `short` |
| `market_index` | Spot market index |
| `amount` | Order size |
| `price_limit` | Limit price |

### `glam-cli drift-protocol perp`

Place perpetual market order.

```bash
glam-cli drift-protocol perp <direction> <market_index> <amount> <price_limit> [--sub-account-id <id>] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `direction` | `long` or `short` |
| `market_index` | Perp market index (0=SOL-PERP) |
| `amount` | Order size in base units |
| `price_limit` | Limit price |

**Examples:**

```bash
# Long 1 SOL-PERP at market
glam-cli drift-protocol perp long 0 1 0

# Short 0.5 SOL-PERP with limit price
glam-cli drift-protocol perp short 0 0.5 100

# Close position
glam-cli drift-protocol perp short 0 1 0
```

### `glam-cli drift-protocol list-positions`

List open positions.

```bash
glam-cli drift-protocol list-positions [--sub-account-id <id>]
```

### `glam-cli drift-protocol list-orders`

List open orders.

```bash
glam-cli drift-protocol list-orders [--sub-account-id <id>]
```

### `glam-cli drift-protocol list-users`

List Drift sub-accounts for the vault.

```bash
glam-cli drift-protocol list-users
```

### `glam-cli drift-protocol cancel`

Cancel Drift order(s).

```bash
glam-cli drift-protocol cancel <order_ids...> [--sub-account-id <id>] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `order_ids` | One or more order IDs to cancel |

---

## Policy Commands

### `glam-cli drift-protocol view-policy`

View Drift policy settings for the vault.

```bash
glam-cli drift-protocol view-policy
```

### `glam-cli drift-protocol allowlist-market`

Add a market to the Drift allowlist.

```bash
glam-cli drift-protocol allowlist-market <spot|perp> <market_index> [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `spot\|perp` | Market type |
| `market_index` | Market index to allowlist |

### `glam-cli drift-protocol remove-market`

Remove a market from the Drift allowlist.

```bash
glam-cli drift-protocol remove-market <spot|perp> <market_index> [--yes]
```

### `glam-cli drift-protocol allowlist-borrowable-asset`

Add an asset to the borrowable allowlist.

```bash
glam-cli drift-protocol allowlist-borrowable-asset <token_mint> [--yes]
```

### `glam-cli drift-protocol remove-borrowable-asset`

Remove an asset from the borrowable allowlist.

```bash
glam-cli drift-protocol remove-borrowable-asset <token_mint> [--yes]
```

---

## User Management Commands

### `glam-cli drift-protocol margin`

Enable or disable margin trading for the Drift user.

```bash
glam-cli drift-protocol margin <bool> [--sub-account-id <id>] [--yes]
```

### `glam-cli drift-protocol settle`

Settle PnL for a market.

```bash
glam-cli drift-protocol settle <market_index> [--sub-account-id <id>]
```

### `glam-cli drift-protocol delete-user`

Delete a Drift user account.

```bash
glam-cli drift-protocol delete-user <sub_account_id> [--yes]
```

### `glam-cli drift-protocol update-user-pool-id`

Update the user pool ID.

```bash
glam-cli drift-protocol update-user-pool-id <sub_account_id> <pool_id> [--yes]
```

---

## Market Indices

### Spot Markets
| Index | Asset |
|-------|-------|
| 0 | USDC |
| 1 | SOL |
| 2 | mSOL |
| 3 | wBTC |
| 4 | wETH |

### Perp Markets
| Index | Market |
|-------|--------|
| 0 | SOL-PERP |
| 1 | BTC-PERP |
| 2 | ETH-PERP |

---

## Typical Workflow

```bash
# 1. Enable integration
glam-cli integration enable DriftProtocol

# 2. Initialize user (required once)
glam-cli drift-protocol init-user

# 3. Deposit collateral
glam-cli drift-protocol deposit 0 1000  # 1000 USDC

# 4. Open position
glam-cli drift-protocol perp long 0 1 0

# 5. Monitor positions
glam-cli drift-protocol list-positions

# 6. Close position
glam-cli drift-protocol perp short 0 1 0
```
