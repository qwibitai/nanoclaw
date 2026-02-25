# CLI: Token Transfers

Transfer SPL tokens from vault to allowlisted destinations.

## Commands

### `glam-cli transfer <AMOUNT> <TO>`

Transfer tokens to a destination address.

```bash
glam-cli transfer <AMOUNT> <TO> [OPTIONS] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `AMOUNT` | Amount to transfer |
| `TO` | Destination address (must be allowlisted) |

**Options:**
| Flag | Description |
|------|-------------|
| `-t, --token <MINT>` | Token mint address (defaults to wSOL) |
| `-y, --yes` | Skip confirmation prompt |

**Examples:**
```bash
# Transfer 10 wSOL
glam-cli transfer 10 <DESTINATION_PUBKEY>

# Transfer 100 USDC
glam-cli transfer 100 <DESTINATION_PUBKEY> --token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### `glam-cli transfer view-policy`

View the token transfer allowlist.

```bash
glam-cli transfer view-policy
```

### `glam-cli transfer allowlist-destination`

Add a destination address to the transfer allowlist.

```bash
glam-cli transfer allowlist-destination <PUBKEY> [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |

### `glam-cli transfer remove-destination`

Remove a destination from the allowlist.

```bash
glam-cli transfer remove-destination <PUBKEY> [--yes]
```

---

## Workflow

```bash
# 1. Check current allowlist
glam-cli transfer view-policy

# 2. Add destination to allowlist (required before transferring)
glam-cli transfer allowlist-destination <DESTINATION_PUBKEY>

# 3. Transfer tokens
glam-cli transfer 100 <DESTINATION_PUBKEY> --token <MINT>

# 4. Remove destination if no longer needed
glam-cli transfer remove-destination <DESTINATION_PUBKEY>
```

---

## Important Notes

- **Allowlist required**: Destinations must be allowlisted before transfers
- **Default token**: If no `--token` specified, transfers wSOL
- **Security**: Use allowlist to prevent unauthorized fund movement
