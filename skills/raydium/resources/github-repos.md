# Raydium GitHub Repositories

Comprehensive documentation for Raydium's open-source tools on GitHub.

**Organization:** [github.com/raydium-io](https://github.com/raydium-io)

---

## SDKs & Developer Tools

### raydium-sdk-V2

**Repository:** [raydium-io/raydium-sdk-V2](https://github.com/raydium-io/raydium-sdk-V2)
**Language:** TypeScript
**Stars:** 339+

The official TypeScript SDK for building applications with Raydium.

#### Installation

```bash
npm install @raydium-io/raydium-sdk-v2
# or
yarn add @raydium-io/raydium-sdk-v2
```

#### Key Features

- Full CLMM, CPMM, and AMM V4 support
- Pool creation and management
- Swap execution with routing
- Position management for concentrated liquidity
- Farm operations
- LaunchLab integration

#### Basic Usage

```typescript
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";

const raydium = await Raydium.load({
  connection: new Connection("https://api.mainnet-beta.solana.com"),
  owner: keypair,
  cluster: "mainnet",
});

// Access pools, tokens, farms
const pools = await raydium.api.fetchPoolByMints({
  mint1: "So11...",
  mint2: "EPjF...",
});
```

---

### raydium-sdk-V2-demo

**Repository:** [raydium-io/raydium-sdk-V2-demo](https://github.com/raydium-io/raydium-sdk-V2-demo)
**Language:** TypeScript
**Stars:** 261+

Example implementations demonstrating SDK usage.

#### Available Demos

```
src/
├── amm/           # AMM V4 operations
├── clmm/          # Concentrated liquidity
├── cpmm/          # Constant product AMM
├── farm/          # Farming operations
├── marketV2/      # Market creation
└── utils/         # Helper functions
```

#### Running Demos

```bash
git clone https://github.com/raydium-io/raydium-sdk-V2-demo
cd raydium-sdk-V2-demo
yarn install

# Run specific demo
yarn dev src/cpmm/swap.ts
yarn dev src/clmm/createPool.ts
```

---

### raydium-idl

**Repository:** [raydium-io/raydium-idl](https://github.com/raydium-io/raydium-idl)
**Language:** TypeScript

Interface Definition Language (IDL) files for Raydium programs.

#### Installation

```bash
yarn add @raydium-io/raydium-idl
```

#### Usage

```typescript
import { IDL as AmmIdl } from "@raydium-io/raydium-idl/amm";
import { IDL as ClmmIdl } from "@raydium-io/raydium-idl/clmm";
import { IDL as CpmmIdl } from "@raydium-io/raydium-idl/cpmm";

// Use with Anchor
import { Program } from "@coral-xyz/anchor";

const ammProgram = new Program(AmmIdl, AMM_PROGRAM_ID, provider);
const clmmProgram = new Program(ClmmIdl, CLMM_PROGRAM_ID, provider);
```

---

## Smart Contracts (Rust)

### raydium-clmm

**Repository:** [raydium-io/raydium-clmm](https://github.com/raydium-io/raydium-clmm)
**Language:** Rust
**Stars:** 363+
**License:** Apache-2.0

Open-source Concentrated Liquidity Market Maker program.

#### Program ID

```
Mainnet: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
Devnet: devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH
```

#### Features

- Concentrated liquidity positions
- NFT-based position representation
- Multiple fee tiers (0.01%, 0.05%, 0.25%, 1%)
- Tick-based price ranges
- Farm reward distribution

#### Building

```bash
git clone https://github.com/raydium-io/raydium-clmm
cd raydium-clmm
anchor build
```

---

### raydium-cp-swap

**Repository:** [raydium-io/raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap)
**Language:** Rust
**Stars:** 225+

Revamped constant product AMM with Token22 support.

#### Program ID

```
Mainnet: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
Devnet: CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW
```

#### Features

- No OpenBook market required
- Token-2022 (Token Extensions) support
- Fungible LP tokens
- Lock liquidity for rewards
- Creator fee collection

#### Building

```bash
git clone https://github.com/raydium-io/raydium-cp-swap
cd raydium-cp-swap
anchor build
```

---

### raydium-amm

**Repository:** [raydium-io/raydium-amm](https://github.com/raydium-io/raydium-amm)
**Language:** Rust
**Stars:** 341+

Classic constant product AMM integrated with OpenBook CLOB.

#### Program ID

```
Mainnet: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
Devnet: DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav
```

#### Features

- Hybrid AMM + Order Book liquidity
- Proven, high TVL pools
- Deep integration with Solana DeFi

---

## CPI Integration

### raydium-cpi

**Repository:** [raydium-io/raydium-cpi](https://github.com/raydium-io/raydium-cpi)
**Language:** Rust

Cross-Program Invocation library for integrating Raydium in your Solana programs.

#### Use Cases

- Build on-chain arbitrage bots
- Create vault strategies
- Integrate swaps into your protocol
- Compose with other DeFi protocols

#### Installation

```toml
# Cargo.toml
[dependencies]
raydium-cpi = { git = "https://github.com/raydium-io/raydium-cpi" }
```

#### CPMM CPI Example

```rust
use anchor_lang::prelude::*;
use raydium_cpi::cpmm;

#[program]
pub mod my_program {
    use super::*;

    pub fn swap_via_raydium(
        ctx: Context<SwapViaRaydium>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        // Build CPI context
        let cpi_accounts = cpmm::cpi::accounts::Swap {
            payer: ctx.accounts.payer.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
            amm_config: ctx.accounts.amm_config.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            input_token_account: ctx.accounts.input_token_account.to_account_info(),
            output_token_account: ctx.accounts.output_token_account.to_account_info(),
            input_vault: ctx.accounts.input_vault.to_account_info(),
            output_vault: ctx.accounts.output_vault.to_account_info(),
            input_token_program: ctx.accounts.input_token_program.to_account_info(),
            output_token_program: ctx.accounts.output_token_program.to_account_info(),
            input_token_mint: ctx.accounts.input_token_mint.to_account_info(),
            output_token_mint: ctx.accounts.output_token_mint.to_account_info(),
            observation_state: ctx.accounts.observation_state.to_account_info(),
        };

        let cpi_program = ctx.accounts.cpmm_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Execute swap
        cpmm::cpi::swap_base_input(cpi_ctx, amount_in, minimum_amount_out)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SwapViaRaydium<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pool authority PDA
    pub authority: UncheckedAccount<'info>,
    pub amm_config: Account<'info, cpmm::states::AmmConfig>,
    #[account(mut)]
    pub pool_state: Account<'info, cpmm::states::PoolState>,
    #[account(mut)]
    pub input_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub input_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_vault: Account<'info, TokenAccount>,
    pub input_token_program: Program<'info, Token>,
    pub output_token_program: Program<'info, Token>,
    pub input_token_mint: Account<'info, Mint>,
    pub output_token_mint: Account<'info, Mint>,
    #[account(mut)]
    pub observation_state: AccountLoader<'info, cpmm::states::ObservationState>,
    pub cpmm_program: Program<'info, cpmm::program::RaydiumCpSwap>,
}
```

#### CLMM CPI Example

```rust
use raydium_cpi::clmm;

pub fn swap_via_clmm(
    ctx: Context<SwapViaClmm>,
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit_x64: u128,
    is_base_input: bool,
) -> Result<()> {
    let cpi_accounts = clmm::cpi::accounts::SwapSingle {
        payer: ctx.accounts.payer.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: ctx.accounts.input_token_account.to_account_info(),
        output_token_account: ctx.accounts.output_token_account.to_account_info(),
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        tick_array: ctx.accounts.tick_array.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(
        ctx.accounts.clmm_program.to_account_info(),
        cpi_accounts,
    );

    clmm::cpi::swap(
        cpi_ctx,
        amount,
        other_amount_threshold,
        sqrt_price_limit_x64,
        is_base_input,
    )?;

    Ok(())
}
```

---

## UI Components

### raydium-ui-v3-public

**Repository:** [raydium-io/raydium-ui-v3-public](https://github.com/raydium-io/raydium-ui-v3-public)
**Language:** TypeScript/React

Frontend components library for building Raydium-style interfaces.

---

## Documentation

### raydium-docs

**Repository:** [raydium-io/raydium-docs](https://github.com/raydium-io/raydium-docs)

Source for official Raydium documentation.

---

## Quick Reference

| Repository | Language | Purpose | Stars |
|------------|----------|---------|-------|
| raydium-sdk-V2 | TypeScript | Official SDK | 339+ |
| raydium-sdk-V2-demo | TypeScript | SDK examples | 261+ |
| raydium-clmm | Rust | CLMM program | 363+ |
| raydium-cp-swap | Rust | CPMM program | 225+ |
| raydium-amm | Rust | AMM V4 program | 341+ |
| raydium-cpi | Rust | CPI library | - |
| raydium-idl | TypeScript | IDL definitions | - |
| raydium-ui-v3-public | TypeScript | UI components | - |

---

## Contributing

All Raydium repositories accept contributions:

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

**Community:** [Discord](https://discord.gg/raydium) | [Twitter](https://twitter.com/RaydiumProtocol)
