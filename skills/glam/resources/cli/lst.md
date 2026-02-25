# CLI: LST (Liquid Staking Tokens)

> **Warning: Unaudited Integration**
>
> The `glam-cli lst` commands use **unaudited** integrations and require BOTH:
> 1. `NODE_ENV=development` environment variable
> 2. `--bypass-warning` (or `-b`) flag on the parent command
>
> ```bash
> NODE_ENV=development glam-cli lst --bypass-warning stake <STAKEPOOL> 100
> ```

Stake SOL into SPL stake pools or Sanctum pools to receive liquid staking tokens.

> **Note:** For Marinade-specific staking, see [staking.md](./staking.md).

## Prerequisites

```bash
# Enable the integration first (use exact protocol name)
glam-cli integration enable StakePool        # For SPL stake pools
glam-cli integration enable SanctumSingle    # For Sanctum single-validator pools
glam-cli integration enable SanctumMulti     # For Sanctum multi-validator pools
```

## Commands

### `glam-cli lst stake`

Stake SOL into a stake pool to receive LST.

```bash
NODE_ENV=development glam-cli lst --bypass-warning stake <stakepool> <amount> [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `stakepool` | Stake pool address |
| `amount` | Amount of SOL to stake |

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |

**Example:**
```bash
NODE_ENV=development glam-cli lst -b stake StakePoolAddress111... 10
```

### `glam-cli lst unstake`

Unstake LST to receive SOL in a stake account.

```bash
NODE_ENV=development glam-cli lst --bypass-warning unstake <asset> <amount> [OPTIONS] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `asset` | LST token mint address |
| `amount` | Amount of LST to unstake |

**Options:**
| Flag | Description |
|------|-------------|
| `-d, --deactivate` | Deactivate the stake account |
| `-y, --yes` | Skip confirmation prompt |

**Example:**
```bash
# Unstake 5 LST tokens
NODE_ENV=development glam-cli lst -b unstake LstMintAddress111... 5

# Unstake and deactivate stake account
NODE_ENV=development glam-cli lst -b unstake LstMintAddress111... 5 --deactivate
```

---

## Workflow

```bash
# 1. Enable integration
glam-cli integration enable StakePool

# 2. Stake SOL to receive LST
NODE_ENV=development glam-cli lst --bypass-warning stake <STAKEPOOL_ADDRESS> 100

# 3. Later: unstake to get SOL back
NODE_ENV=development glam-cli lst --bypass-warning unstake <LST_MINT> 100 --deactivate
```

---

## Common Stake Pools

| Pool | Description |
|------|-------------|
| Marinade | mSOL - use `glam-cli marinade` commands instead |
| Jito | jitoSOL |
| BlazeStake | bSOL |
| Sanctum | Various LSTs |

---

## Important Notes

- **Unstake delay**: Unstaking typically has an epoch delay (~2-3 days)
- **Stake accounts**: Unstaking creates stake accounts that need deactivation
- **Different from Marinade**: For Marinade, use `glam-cli marinade` commands which have additional features
