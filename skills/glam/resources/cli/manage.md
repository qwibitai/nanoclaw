# CLI: Manage Commands

Vault management operations for tokenized vaults: pricing, fulfillment, fees, and subscription controls.

## Commands

### `glam-cli manage price`

Price vault assets (update NAV).

```bash
glam-cli manage price
```

Updates the vault's Net Asset Value based on current market prices.

### `glam-cli manage fulfill`

Fulfill queued subscriptions and redemptions.

```bash
glam-cli manage fulfill
```

Processes pending investor subscriptions and redemptions at current NAV.

### `glam-cli manage claim-fees`

Claim accrued management fees.

```bash
glam-cli manage claim-fees
```

### `glam-cli manage update-min-subscription`

Set minimum subscription amount.

```bash
glam-cli manage update-min-subscription <AMOUNT> [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |

**Example:**
```bash
# Set minimum subscription to 100 USDC
glam-cli manage update-min-subscription 100
```

### `glam-cli manage update-min-redemption`

Set minimum redemption amount.

```bash
glam-cli manage update-min-redemption <AMOUNT> [--yes]
```

### `glam-cli manage pause`

Pause subscription or redemption.

```bash
glam-cli manage pause <ACTION> [--yes]
```

**Arguments:**
| Argument | Values |
|----------|--------|
| `ACTION` | `subscription` or `redemption` |

**Example:**
```bash
# Pause new subscriptions
glam-cli manage pause subscription

# Pause redemptions
glam-cli manage pause redemption
```

### `glam-cli manage unpause`

Resume subscription or redemption.

```bash
glam-cli manage unpause <ACTION> [--yes]
```

**Example:**
```bash
# Resume subscriptions
glam-cli manage unpause subscription
```

### `glam-cli manage list-requests`

List pending user requests in the subscription/redemption queue.

```bash
glam-cli manage list-requests
```

**Output shows:**
- User public key
- Request type (subscription or redemption)
- Incoming/outgoing amounts
- Status (pending or fulfilled/claimable)
- Created timestamp

### `glam-cli manage cancel-for-user`

Cancel a queued request on behalf of a user.

```bash
glam-cli manage cancel-for-user <pubkey> [--yes]
```

### `glam-cli manage claim-for-user`

Claim a fulfilled request on behalf of a user.

```bash
glam-cli manage claim-for-user <pubkey> [--yes]
```

---

## Manager Workflow

```bash
# Daily/periodic operations for tokenized vault managers:

# 1. Price vault (update NAV)
glam-cli manage price

# 2. Process pending subscriptions/redemptions
glam-cli manage fulfill

# 3. Claim fees (when desired)
glam-cli manage claim-fees
```

---

## Emergency Controls

```bash
# Pause all new subscriptions (e.g., during market volatility)
glam-cli manage pause subscription

# Resume when ready
glam-cli manage unpause subscription
```

---

## Important Notes

- **For tokenized vaults only**: These commands apply to vaults with share classes
- **Pricing first**: Always price before fulfill to ensure accurate NAV
- **Pause controls**: Useful for maintenance windows or emergencies
