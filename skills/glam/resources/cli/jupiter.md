# CLI: Jupiter Commands

Token swaps via Jupiter aggregator.

**Prerequisite:** Enable `JupiterSwap` integration before using these commands.

```bash
glam-cli integration enable JupiterSwap
```

## Commands

### `glam-cli jupiter swap`

Execute token swap via Jupiter.

```bash
glam-cli jupiter swap <from> <to> <amount> [OPTIONS] [--yes]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `from` | Input token mint address or symbol (e.g., `USDC`, `SOL`) |
| `to` | Output token mint address or symbol |
| `amount` | Amount in token units (decimal-adjusted) |

**Options:**
| Flag | Description | Default |
|------|-------------|---------|
| `-s, --slippage-bps <BPS>` | Slippage tolerance in basis points | 5 (0.05%) |
| `-m, --max-accounts <NUM>` | Max accounts allowed in swap route | - |
| `--use-v2` | Use v2 swap instruction | false |
| `-d, --only-direct-routes` | Use only direct routes | false |
| `-y, --yes` | Skip confirmation prompt | - |

**Examples:**

```bash
# Swap 100 USDC to SOL using symbols
glam-cli jupiter swap USDC SOL 100 --slippage-bps 50

# Swap using mint addresses with 0.5% slippage
glam-cli jupiter swap \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  So11111111111111111111111111111111111111112 \
  100 \
  --slippage-bps 50

# Swap with 1% slippage
glam-cli jupiter swap USDC SOL 1000 --slippage-bps 100

# Use direct routes only (less hops, potentially worse price)
glam-cli jupiter swap USDC SOL 1000 --only-direct-routes
```

### `glam-cli jupiter view-policy`

View vault's Jupiter swap policy (max slippage, allowlisted tokens).

```bash
glam-cli jupiter view-policy
```

### `glam-cli jupiter set-max-slippage`

Set maximum slippage for swaps.

```bash
glam-cli jupiter set-max-slippage <slippage_bps> [--yes]
```

**Example:**

```bash
# Set max slippage to 1% (100 basis points)
glam-cli jupiter set-max-slippage 100
```

### `glam-cli jupiter allowlist-token`

Add token to swap allowlist.

```bash
glam-cli jupiter allowlist-token <token_mint> [--yes]
```

### `glam-cli jupiter remove-token`

Remove a token from the swap allowlist.

```bash
glam-cli jupiter remove-token <token_mint> [--yes]
```

### `glam-cli jupiter clear-allowlist`

Clear all tokens from the swap allowlist.

```bash
glam-cli jupiter clear-allowlist [--yes]
```

---

## Slippage Reference

| BPS | Percentage |
|-----|------------|
| 5 | 0.05% (default) |
| 10 | 0.1% |
| 50 | 0.5% |
| 100 | 1.0% |
| 200 | 2.0% |
| 500 | 5.0% |

---

## Common Token Mints

| Token | Mainnet Address |
|-------|-----------------|
| SOL | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` |
| jitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| bSOL | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` |
