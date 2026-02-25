# CLI: Kamino Farms

Stake tokens in Kamino farms to earn rewards.

## Prerequisites

```bash
# Enable the integration first
glam-cli integration enable KaminoFarms
```

## Commands

### `glam-cli kamino-farms list`

List Kamino farms where your vault has unclaimed rewards.

```bash
glam-cli kamino-farms list
```

**Output shows:**
- Vault farm user address
- Reward token mint
- Unclaimed reward amount

### `glam-cli kamino-farms stake`

Stake tokens to a Kamino farm.

```bash
glam-cli kamino-farms stake <FARM_STATE> <AMOUNT> [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `FARM_STATE` | Farm state public key |
| `AMOUNT` | Amount of farm token to stake |

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |

**Example:**
```bash
# Stake 100 tokens to a farm
glam-cli kamino-farms stake FarmState111... 100
```

### `glam-cli kamino-farms unstake`

Unstake tokens from a Kamino farm.

```bash
glam-cli kamino-farms unstake <FARM_STATE> <AMOUNT> [--yes]
```

**Example:**
```bash
# Unstake 50 tokens from a farm
glam-cli kamino-farms unstake FarmState111... 50
```

### `glam-cli kamino-farms harvest`

Harvest (claim) rewards from one or more farms.

```bash
glam-cli kamino-farms harvest <FARM_STATE...> [--yes]
```

**Example:**
```bash
# Harvest from single farm
glam-cli kamino-farms harvest FarmState111...

# Harvest from multiple farms at once
glam-cli kamino-farms harvest FarmState111... FarmState222... FarmState333...
```

---

## Workflow

```bash
# 1. Enable integration
glam-cli integration enable KaminoFarms

# 2. Stake tokens to earn rewards
glam-cli kamino-farms stake <FARM_STATE> 1000

# 3. Check unclaimed rewards
glam-cli kamino-farms list

# 4. Harvest rewards
glam-cli kamino-farms harvest <FARM_STATE>

# 5. When done: unstake
glam-cli kamino-farms unstake <FARM_STATE> 1000
```

---

## Important Notes

- **Different from Kamino Lending/Vaults**: This is for liquidity mining rewards
- **Multiple harvests**: You can harvest from multiple farms in one transaction
- **Reward tokens**: Rewards are typically protocol tokens or other incentives
