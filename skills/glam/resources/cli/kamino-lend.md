# CLI: Kamino Lend Commands (`glam-cli kamino-lend`)

Lending and borrowing via Kamino Finance.

**Prerequisite:** Enable `KaminoLend` integration before using these commands.

```bash
glam-cli integration enable KaminoLend
```

## Commands

### `glam-cli kamino-lend init`

Initialize Kamino lending for vault. **Required before any Kamino operations.**

```bash
glam-cli kamino-lend init
```

### `glam-cli kamino-lend deposit`

Deposit to Kamino lending market.

```bash
glam-cli kamino-lend deposit <market> <asset> <amount> [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `market` | Lending market address |
| `asset` | Token mint to deposit |
| `amount` | Amount to deposit |

**Example:**

```bash
# Deposit 1000 USDC to main market
glam-cli kamino-lend deposit \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  1000
```

### `glam-cli kamino-lend withdraw`

Withdraw from Kamino lending market.

```bash
glam-cli kamino-lend withdraw <market> <asset> <amount> [--yes]
```

### `glam-cli kamino-lend borrow`

Borrow from Kamino lending market.

```bash
glam-cli kamino-lend borrow <market> <asset> <amount> [--yes]
```

### `glam-cli kamino-lend repay`

Repay Kamino loan.

```bash
glam-cli kamino-lend repay <market> <asset> <amount> [--yes]
```

### `glam-cli kamino-lend list`

List Kamino lending positions.

```bash
glam-cli kamino-lend list
```

---

## Policy Commands

### `glam-cli kamino-lend view-policy`

View Kamino lending policy settings for the vault.

```bash
glam-cli kamino-lend view-policy
```

### `glam-cli kamino-lend allowlist-market`

Add a lending market to the allowlist.

```bash
glam-cli kamino-lend allowlist-market <market> [--yes]
```

### `glam-cli kamino-lend remove-market`

Remove a lending market from the allowlist.

```bash
glam-cli kamino-lend remove-market <market> [--yes]
```

### `glam-cli kamino-lend allowlist-borrowable-asset`

Add an asset to the borrowable allowlist.

```bash
glam-cli kamino-lend allowlist-borrowable-asset <asset> [--yes]
```

### `glam-cli kamino-lend remove-borrowable-asset`

Remove an asset from the borrowable allowlist.

```bash
glam-cli kamino-lend remove-borrowable-asset <asset> [--yes]
```

---

## Kamino Market Addresses

| Market | Address | Description |
|--------|---------|-------------|
| Main Market | `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` | Primary lending market |
| JLP Market | `DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek` | JLP collateral market |
| Altcoins | `ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5` | Altcoin market |

---

## Typical Workflow

```bash
# 1. Enable integration
glam-cli integration enable KaminoLend

# 2. Initialize (required once)
glam-cli kamino-lend init

# 3. Deposit collateral
glam-cli kamino-lend deposit \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  5000

# 4. Borrow against collateral
glam-cli kamino-lend borrow \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  So11111111111111111111111111111111111111112 \
  10

# 5. Monitor positions
glam-cli kamino-lend list

# 6. Repay loan
glam-cli kamino-lend repay \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  So11111111111111111111111111111111111111112 \
  10

# 7. Withdraw collateral
glam-cli kamino-lend withdraw \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  5000
```
