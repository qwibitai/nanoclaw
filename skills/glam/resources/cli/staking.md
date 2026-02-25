# CLI: Staking Commands

> **Warning: Unaudited Integrations**
>
> The `glam-cli marinade`, `glam-cli stake`, and `glam-cli lst` commands use **unaudited** integrations and require BOTH:
> 1. `NODE_ENV=development` environment variable
> 2. `--bypass-warning` (or `-b`) flag on the parent command
>
> Without both, the command will print `"Unaudited integration. Use with caution."` and exit.
>
> ```bash
> NODE_ENV=development glam-cli marinade --bypass-warning stake 100
> ```

SOL staking operations via multiple protocols.

## Available Staking Integrations

| Integration | Protocol Name | Description | Staging |
|-------------|--------------|-------------|---------|
| Marinade | `Marinade` | Marinade liquid staking (mSOL) | Yes |
| Native Staking | `StakeProgram` | Native Solana staking (stake accounts) | Yes |
| SPL Stake Pools | `StakePool` | SPL stake pools (via `lst` command) | Yes |
| Sanctum Single | `SanctumSingle` | Sanctum single-validator pools (via `lst` command) | Yes |
| Sanctum Multi | `SanctumMulti` | Sanctum multi-validator pools (via `lst` command) | Yes |

## Marinade Staking

**Prerequisite:** Enable `Marinade` integration.

```bash
glam-cli integration enable Marinade
```

### Stake SOL to get mSOL

```bash
NODE_ENV=development glam-cli marinade --bypass-warning stake <amount> [--yes]
```

### Stake SOL to Marinade Native

```bash
NODE_ENV=development glam-cli marinade --bypass-warning stake-native <amount> [--yes]
```

### Withdraw mSOL into a stake account

```bash
NODE_ENV=development glam-cli marinade --bypass-warning withdraw-stake <amount> [--deactivate] [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-d, --deactivate` | Deactivate the stake account |
| `-y, --yes` | Skip confirmation prompt |

---

## Native Staking

**Prerequisite:** Enable `StakeProgram` integration.

```bash
glam-cli integration enable StakeProgram
```

### List stake accounts

```bash
NODE_ENV=development glam-cli stake --bypass-warning list
```

### Deactivate stake accounts

```bash
NODE_ENV=development glam-cli stake --bypass-warning deactivate <accounts...> [--yes]
```

Takes one or more stake account pubkeys (space-separated).

### Withdraw from stake accounts

```bash
NODE_ENV=development glam-cli stake --bypass-warning withdraw <accounts...> [--yes]
```

Takes one or more stake account pubkeys (space-separated). Stake accounts must be fully deactivated before withdrawal.

---

## SPL Stake Pools & Sanctum

SPL stake pool and Sanctum operations use the `glam-cli lst` command. There are no separate `stake-pool` or `sanctum` command groups.

**Prerequisites:**

```bash
# For SPL stake pools
glam-cli integration enable StakePool

# For Sanctum pools
glam-cli integration enable SanctumSingle
# or
glam-cli integration enable SanctumMulti
```

### Stake SOL into a pool

```bash
NODE_ENV=development glam-cli lst --bypass-warning stake <stakepool> <amount> [--yes]
```

### Unstake from a pool

```bash
NODE_ENV=development glam-cli lst --bypass-warning unstake <asset> <amount> [--deactivate] [--yes]
```

See [lst.md](./lst.md) for full details.

---

## Common LST Mints

| LST | Mint Address |
|-----|--------------|
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` |
| jitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| bSOL | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` |
| INF | `5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm` |

---

## Typical Marinade Workflow

```bash
# 1. Enable integration
glam-cli integration enable Marinade

# 2. Stake SOL
NODE_ENV=development glam-cli marinade --bypass-warning stake 100

# 3. Later, withdraw mSOL into a stake account
NODE_ENV=development glam-cli marinade --bypass-warning withdraw-stake 50

# 4. Or withdraw and deactivate in one step
NODE_ENV=development glam-cli marinade --bypass-warning withdraw-stake 50 --deactivate
```
