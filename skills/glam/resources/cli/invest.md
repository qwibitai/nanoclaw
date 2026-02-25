# CLI: Invest Commands

Tokenized vault subscription and redemption operations.

## Investor Commands

### `glam-cli invest subscribe`

Subscribe to a tokenized vault (deposit funds to receive shares).

```bash
glam-cli invest subscribe <amount> [state] [--queued] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `amount` | Subscription amount in base asset |
| `state` | Optional vault state (uses active vault if omitted) |

**Options:**
| Flag | Description |
|------|-------------|
| `--queued` | Queue the subscription (for notify-and-settle vaults) |
| `-y, --yes` | Skip confirmation prompt |

### `glam-cli invest claim-subscription`

Claim processed subscription shares.

```bash
glam-cli invest claim-subscription
```

### `glam-cli invest redeem`

Redeem shares from vault.

```bash
glam-cli invest redeem <amount> [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `amount` | Number of shares to redeem |

### `glam-cli invest claim-redemption`

Claim processed redemption proceeds.

```bash
glam-cli invest claim-redemption
```

### `glam-cli invest cancel-request`

Cancel a pending subscription or redemption request.

```bash
glam-cli invest cancel-request [--yes]
```

---

## Subscription/Redemption Flow

### For Investors

```bash
# 1. Subscribe with USDC
glam-cli invest subscribe 1000

# 2. Wait for manager to fulfill...

# 3. Claim your shares
glam-cli invest claim-subscription

# Later, to exit:

# 4. Redeem shares
glam-cli invest redeem 100

# 5. Wait for manager to fulfill...

# 6. Claim your USDC
glam-cli invest claim-redemption
```

### For Managers

```bash
# 1. Update NAV price (should reflect current portfolio value)
glam-cli manage price

# 2. Fulfill pending subscriptions/redemptions
glam-cli manage fulfill

# 3. Periodically claim fees
glam-cli manage claim-fees
```
