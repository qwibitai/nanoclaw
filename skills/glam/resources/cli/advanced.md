# CLI: Advanced Commands

CCTP cross-chain bridging and timelock operations.

## CCTP Commands (Cross-Chain)

Bridge USDC between chains via Circle's Cross-Chain Transfer Protocol.

### `glam-cli cctp bridge-usdc`

Bridge USDC to another chain.

```bash
glam-cli cctp bridge-usdc <amount> <domain> <destination_address> [OPTIONS] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `amount` | USDC amount to bridge |
| `domain` | Target destination domain ID |
| `destination_address` | Destination address on target chain |

**Options:**
| Flag | Description |
|------|-------------|
| `--destination-caller <ADDRESS>` | Restrict who can receive on destination |
| `--max-fee-bps <BPS>` | Maximum fee in basis points (default: 1) |
| `--base58` | Use base58 encoding for address |
| `--fast` | Use fast bridging mode |
| `-y, --yes` | Skip confirmation prompt |

**Destination domains:**
| Domain | Chain |
|--------|-------|
| 0 | Ethereum |
| 1 | Avalanche |
| 2 | Optimism |
| 3 | Arbitrum |
| 6 | Base |
| 7 | Polygon |

**Example:**

```bash
# Bridge 1000 USDC to Ethereum
glam-cli cctp bridge-usdc 1000 0 0x742d35Cc6634C0532925a3b844Bc9e7595f00000
```

### `glam-cli cctp receive`

Receive bridged USDC (from another chain to Solana).

```bash
glam-cli cctp receive <source_domain> [OPTIONS]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--txHash <HASH>` | Source chain transaction hash to receive |
| `--nonce <NONCE>` | CCTP message nonce to receive |

### `glam-cli cctp list`

List CCTP bridge transactions.

```bash
glam-cli cctp list [OPTIONS]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--since-slot <SLOT>` | Only show events after this slot |
| `--batch-size <SIZE>` | Number of signatures to fetch per batch |
| `--commitment <LEVEL>` | Commitment level (`confirmed`, `finalized`) |

---

## CCTP Policy Commands

### `glam-cli cctp view-policy`

View CCTP policy settings for the vault.

```bash
glam-cli cctp view-policy
```

### `glam-cli cctp allowlist-destination`

Add a destination address/domain to the CCTP allowlist.

```bash
glam-cli cctp allowlist-destination <domain> <address> [--base58] [--yes]
```

### `glam-cli cctp remove-destination`

Remove a destination from the CCTP allowlist.

```bash
glam-cli cctp remove-destination <domain> <address> [--base58] [--yes]
```

---

## Timelock Commands

Protect vault with timelocked configuration changes.

### `glam-cli timelock view`

View current timelock status and pending changes.

```bash
glam-cli timelock view
```

**Output shows:**
- Current timelock duration and remaining time
- Pending state updates with detailed diffs:
  - **integrationAcls**: Added/removed/modified integrations with protocol names
  - **delegateAcls**: Added/removed/modified delegates with permission changes
  - **assets / borrowable**: Added `[+]` and removed `[-]` token mints
  - **timelockDuration**: Old → new duration

### `glam-cli timelock set`

Set timelock duration. Change takes effect after current delay period.

```bash
glam-cli timelock set <duration> [--yes]
```

**Common durations:**
| Seconds | Duration |
|---------|----------|
| 3600 | 1 hour |
| 86400 | 1 day |
| 259200 | 3 days |
| 604800 | 1 week |

**Example:**

```bash
# Set 24-hour timelock
glam-cli timelock set 86400
```

### `glam-cli timelock apply`

Apply pending timelock change after delay period.

```bash
glam-cli timelock apply [--yes]
```

### `glam-cli timelock cancel`

Cancel pending timelock change.

```bash
glam-cli timelock cancel [--yes]
```

---

## Timelock Workflow

```bash
# 1. View current status
glam-cli timelock view

# 2. Set new delay (e.g., 24 hours)
glam-cli timelock set 86400

# 3. Wait for current delay period to pass...

# 4. Apply the change
glam-cli timelock apply

# Or cancel if needed
glam-cli timelock cancel
```

---

## Security Best Practices

1. **Use timelocks for production vaults** - Gives time to react to unauthorized changes
2. **Start with shorter delays** - 1 hour during setup, increase for production
3. **Monitor pending changes** - Check `timelock view` regularly
4. **Cross-chain transfers** - Double-check destination addresses (irreversible)
