# Meteora GitHub Repositories

Comprehensive documentation for Meteora's open-source tools on GitHub.

**Organization:** [github.com/MeteoraAg](https://github.com/MeteoraAg)

---

## TypeScript SDKs

### dlmm-sdk

**Repository:** [MeteoraAg/dlmm-sdk](https://github.com/MeteoraAg/dlmm-sdk)
**Stars:** 280+
**Language:** TypeScript

SDK for building applications on Meteora's Dynamic Liquidity Market Maker (DLMM).

```bash
npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js
```

**Key Features:**
- Concentrated liquidity positions
- Dynamic fee adjustments
- Multiple liquidity strategies
- Fee and reward claiming

---

### cp-amm-sdk (DAMM v2)

**Repository:** [MeteoraAg/damm-v2-sdk](https://github.com/MeteoraAg/cp-amm-sdk)
**Stars:** 44+
**Language:** TypeScript

SDK for the next-generation DAMM v2 constant product AMM.

```bash
npm install @meteora-ag/cp-amm-sdk @solana/web3.js
```

**Key Features:**
- Position NFTs
- Dynamic fee scheduler
- Token-2022 support
- Permissionless farms

---

### damm-v1-sdk

**Repository:** [MeteoraAg/damm-v1-sdk](https://github.com/MeteoraAg/damm-v1-sdk)
**Stars:** 126+
**Language:** TypeScript (69.5%), Rust (30.5%)

SDK for the legacy DAMM v1 (Mercurial Dynamic AMM).

```bash
npm install @meteora-ag/dynamic-amm @solana/web3.js @coral-xyz/anchor
```

**Program ID:** `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`

**Key Features:**
- Constant product pools
- Stable pools (low slippage for pegged assets)
- Weighted pools (custom token ratios)
- LST pools (liquid staking tokens)

---

### dynamic-bonding-curve-sdk

**Repository:** [MeteoraAg/dynamic-bonding-curve-sdk](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk)
**Stars:** 35+
**Language:** TypeScript

SDK for building customizable bonding curve token launches.

```bash
npm install @meteora-ag/dynamic-bonding-curve-sdk
```

**Key Features:**
- Customizable price curves (up to 16 points)
- Auto-graduation to DAMM v1 or v2
- LP token locking
- Creator fee collection

---

### zap-sdk

**Repository:** [MeteoraAg/zap-sdk](https://github.com/MeteoraAg/zap-sdk)
**Stars:** 2+
**Language:** TypeScript

SDK for single-token entry/exit from DAMM v2, DLMM, or Jupiter.

```bash
npm install @meteora-ag/zap-sdk
```

**Program ID:** `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`

**Key Features:**
- Zap into DLMM positions
- Zap into DAMM v2 positions
- Jupiter integration for optimal routing
- Partial position zap out

**Note:** Requires Jupiter API key (obtain from [Jupiter Portal](https://portal.jup.ag)).

---

### vault-sdk

**Repository:** [MeteoraAg/vault-sdk](https://github.com/MeteoraAg/vault-sdk)
**Language:** TypeScript

SDK for Meteora's yield-optimized Dynamic Vaults.

```bash
npm install @meteora-ag/vault-sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

**Key Features:**
- Deposit/withdraw operations
- Share calculations
- Affiliate integration
- Auto-compounding strategies

---

### alpha-vault-sdk

**Repository:** [MeteoraAg/alpha-vault-sdk](https://github.com/MeteoraAg/alpha-vault-sdk)
**Language:** TypeScript

SDK for Alpha Vault anti-bot protection during token launches.

```bash
npm install @meteora-ag/alpha-vault
```

**Key Features:**
- Deposit window management
- Fair allocation calculations
- Token claim operations
- Anti-snipe protection

---

### stake-for-fee-sdk (M3M3)

**Repository:** [MeteoraAg/stake-for-fee-sdk](https://github.com/MeteoraAg/stake-for-fee-sdk)
**Language:** TypeScript

SDK for Stake2Earn (M3M3) - stake tokens to earn trading fees.

```bash
npm install @meteora-ag/m3m3 @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

**Key Features:**
- Stake/unstake operations
- Fee claiming
- Lock period management
- Escrow handling

---

## Go SDKs

### damm-v2-go

**Repository:** [MeteoraAg/damm-v2-go](https://github.com/MeteoraAg/damm-v2-go)
**Language:** Go

Go implementation for DAMM v2 interactions.

**Use Cases:**
- Server-side integrations
- High-performance trading bots
- Backend services

---

### dbc-go

**Repository:** [MeteoraAg/dbc-go](https://github.com/MeteoraAg/dbc-go)
**Language:** Go

Go SDK for Dynamic Bonding Curve operations.

**Use Cases:**
- Token launch automation
- Graduation monitoring
- Backend trading systems

---

## Core Programs (Rust)

### damm-v2

**Repository:** [MeteoraAg/damm-v2](https://github.com/MeteoraAg/damm-v2)
**Stars:** 98+
**Language:** Rust

The on-chain DAMM v2 program source code.

**Program ID:** `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`

---

### dynamic-bonding-curve

**Repository:** [MeteoraAg/dynamic-bonding-curve](https://github.com/MeteoraAg/dynamic-bonding-curve)
**Stars:** 86+
**Language:** Rust

The on-chain Dynamic Bonding Curve program.

**Program ID:** `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`

---

### zap-program

**Repository:** [MeteoraAg/zap-program](https://github.com/MeteoraAg/zap-program)
**Language:** Rust

The on-chain Zap program for single-token liquidity operations.

**Program ID:** `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`

---

## Developer Tools

### meteora-invent (Metsumi CLI)

**Repository:** [MeteoraAg/meteora-invent](https://github.com/MeteoraAg/meteora-invent)
**Stars:** 28+
**Language:** TypeScript

CLI tool for launching tokens and executing on-chain actions with minimal configuration.

#### Installation

```bash
# Prerequisites: Node.js ≥ 18.0.0, pnpm ≥ 10.0.0
git clone https://github.com/MeteoraAg/meteora-invent.git
cd meteora-invent
npm install -g pnpm
pnpm install
```

#### Available Commands

**DLMM Operations:**
```bash
pnpm dlmm-create-pool              # Create permissionless pool
pnpm dlmm-seed-liquidity-lfg       # Seed liquidity (LFG strategy)
pnpm dlmm-seed-liquidity-single-bin # Seed single bin
pnpm dlmm-set-pool-status          # Enable/disable trading
```

**DAMM v2 Operations:**
```bash
pnpm damm-v2-create-balanced-pool  # Create balanced pool
pnpm damm-v2-create-one-sided-pool # Create one-sided pool
pnpm damm-v2-add-liquidity         # Add liquidity
pnpm damm-v2-remove-liquidity      # Remove liquidity
pnpm damm-v2-split-position        # Split position NFT
pnpm damm-v2-claim-position-fee    # Claim fees
```

**Dynamic Bonding Curve:**
```bash
pnpm dbc-create-config             # Create curve configuration
pnpm dbc-create-pool               # Launch token on curve
pnpm dbc-swap                      # Trade on curve
pnpm dbc-migrate-to-damm-v1        # Graduate to DAMM v1
pnpm dbc-migrate-to-damm-v2        # Graduate to DAMM v2
```

**Vault Operations:**
```bash
pnpm alpha-vault-create            # Create Alpha Vault
pnpm presale-vault-create          # Create Presale Vault (beta)
```

#### Configuration

Configurations are stored in `studio/config/`:
- `dlmm_config.jsonc`
- `damm_v1_config.jsonc`
- `damm_v2_config.jsonc`
- `dbc_config.jsonc`
- `alpha_vault_config.jsonc`

#### Scaffolds

Pre-built templates in `scaffolds/`:
- Next.js launchpad starter
- Token launch templates

---

## Quick Reference

| Repository | Package | Purpose |
|------------|---------|---------|
| dlmm-sdk | `@meteora-ag/dlmm` | Concentrated liquidity |
| cp-amm-sdk | `@meteora-ag/cp-amm-sdk` | DAMM v2 pools |
| damm-v1-sdk | `@meteora-ag/dynamic-amm` | Legacy DAMM pools |
| dynamic-bonding-curve-sdk | `@meteora-ag/dynamic-bonding-curve-sdk` | Token launches |
| zap-sdk | `@meteora-ag/zap-sdk` | Single-token entry |
| vault-sdk | `@meteora-ag/vault-sdk` | Yield vaults |
| alpha-vault-sdk | `@meteora-ag/alpha-vault` | Anti-bot launches |
| m3m3 | `@meteora-ag/m3m3` | Fee staking |

---

## Contributing

All Meteora repositories accept contributions:

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

**Community:**
- [Discord](https://discord.gg/meteora)
- [Twitter](https://twitter.com/MeteoraAG)
- [Documentation](https://docs.meteora.ag)
