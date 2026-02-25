# CLI: Kamino Vaults

Deposit into Kamino's automated yield vaults.

> **Note:** This is different from `glam-cli kamino-lend` (lending/borrowing). Kamino Vaults are automated strategies that manage positions for you.

## Prerequisites

```bash
# Enable the integration first
glam-cli integration enable KaminoVaults
```

## Commands

### `glam-cli kamino-vaults view-policy`

View allowlisted Kamino vaults.

```bash
glam-cli kamino-vaults view-policy
```

### `glam-cli kamino-vaults allowlist-vault`

Add a Kamino vault to the allowlist before depositing.

```bash
glam-cli kamino-vaults allowlist-vault <KAMINO_VAULT_ADDRESS> [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |

### `glam-cli kamino-vaults remove-vault`

Remove a Kamino vault from the allowlist.

```bash
glam-cli kamino-vaults remove-vault <KAMINO_VAULT_ADDRESS> [--yes]
```

### `glam-cli kamino-vaults deposit`

Deposit to a Kamino vault.

```bash
glam-cli kamino-vaults deposit <KAMINO_VAULT_ADDRESS> <AMOUNT> [--yes]
```

**Example:**
```bash
# Deposit 1000 USDC to a Kamino vault
glam-cli kamino-vaults deposit KaminoVaults111... 1000
```

### `glam-cli kamino-vaults withdraw`

Withdraw from a Kamino vault by burning vault shares.

```bash
glam-cli kamino-vaults withdraw <KAMINO_VAULT_ADDRESS> <SHARES_AMOUNT> [--yes]
```

**Example:**
```bash
# Withdraw 500 shares worth of assets
glam-cli kamino-vaults withdraw KaminoVaults111... 500
```

---

## Workflow

```bash
# 1. Enable integration
glam-cli integration enable KaminoVaults

# 2. Allowlist the Kamino vault you want to use
glam-cli kamino-vaults allowlist-vault <KAMINO_VAULT_ADDRESS>

# 3. Deposit
glam-cli kamino-vaults deposit <KAMINO_VAULT_ADDRESS> 1000

# 4. When ready to exit: withdraw
glam-cli kamino-vaults withdraw <KAMINO_VAULT_ADDRESS> 500
```

---

## Popular Kamino Vaults

Kamino vaults are identified by their public key. Common vault types include:
- SOL-USDC liquidity vaults
- Stablecoin yield vaults
- LST yield vaults

Check Kamino's documentation for current vault addresses.

---

## Important Notes

- **Allowlist required**: Must allowlist each Kamino vault before depositing
- **Different from Kamino Lending**: This is for automated vaults, not direct lending/borrowing
- **Shares vs Amount**: Withdrawals are specified in share amounts, not underlying token amounts
