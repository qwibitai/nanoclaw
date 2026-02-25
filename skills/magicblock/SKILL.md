---
name: magicblock
description: Complete guide for MagicBlock Ephemeral Rollups - high-performance Solana execution with sub-10ms latency, gasless transactions, and Solana Plugins. Use when building real-time games, high-frequency trading, or any application requiring ultra-low latency on Solana.
---

# MagicBlock Ephemeral Rollups Guide

A comprehensive guide for building high-performance Solana applications with MagicBlock Ephemeral Rollups - enabling sub-10ms latency and gasless transactions.

## Overview

MagicBlock Ephemeral Rollups (ER) are specialized SVM runtimes that enhance Solana with:
- **Sub-10ms latency** (vs ~400ms on base Solana)
- **Gasless transactions** for seamless UX
- **Full composability** with existing Solana programs
- **Horizontal scaling** via on-demand rollups

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Application                        │
├─────────────────────────────────────────────────────────────┤
│  Base Layer (Solana)          │  Ephemeral Rollup (ER)      │
│  - Initialize accounts        │  - Execute operations       │
│  - Delegate accounts          │  - Process at ~10-50ms      │
│  - Final state commits        │  - Zero gas fees            │
│  - ~400ms finality            │  - Commit state to Solana   │
└─────────────────────────────────────────────────────────────┘
```

### Core Flow

1. **Initialize** - Create accounts on Solana base layer
2. **Delegate** - Transfer account ownership to delegation program
3. **Execute** - Run fast operations on Ephemeral Rollup
4. **Commit** - Sync state back to base layer
5. **Undelegate** - Return ownership to your program

## Prerequisites

```bash
# Required versions
Solana: 2.3.13
Rust: 1.85.0
Anchor: 0.32.1
Node: 24.10.0

# Install Anchor (if needed)
cargo install --git https://github.com/coral-xyz/anchor anchor-cli
```

## Quick Start

### 1. Add Dependencies (Cargo.toml)

```toml
[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }
```

### 2. Program Setup (lib.rs)

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{delegate_account, commit_accounts, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegationProgram;

declare_id!("YourProgramId111111111111111111111111111111");

#[ephemeral]  // Required: enables ER support
#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.state.value = 0;
        Ok(())
    }

    #[delegate]  // Auto-injects delegation accounts
    pub fn delegate(ctx: Context<Delegate>) -> Result<()> {
        Ok(())
    }

    pub fn increment(ctx: Context<Update>) -> Result<()> {
        ctx.accounts.state.value += 1;
        Ok(())
    }

    #[commit]  // Auto-injects commit accounts
    pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
        Ok(())
    }
}
```

### 3. TypeScript Client Setup

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

// CRITICAL: Separate connections for each layer
const baseConnection = new Connection("https://api.devnet.solana.com");
const erConnection = new Connection("https://devnet.magicblock.app");

// Create providers
const baseProvider = new AnchorProvider(baseConnection, wallet, { commitment: "confirmed" });
const erProvider = new AnchorProvider(erConnection, wallet, {
  commitment: "confirmed",
  skipPreflight: true,  // Required for ER
});

// Check delegation status
async function isDelegated(pubkey: PublicKey): Promise<boolean> {
  const info = await baseConnection.getAccountInfo(pubkey);
  return info?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
}
```

## Key Concepts

### Delegation

Delegation transfers PDA ownership to the delegation program, allowing the Ephemeral Validator to process transactions.

```rust
#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Will be delegated
    #[account(mut, del)]  // 'del' marks for delegation
    pub state: AccountInfo<'info>,
    pub delegation_program: Program<'info, DelegationProgram>,
}
```

### Commit

Commits update PDA state from ER to base layer without undelegating.

```rust
use ephemeral_rollups_sdk::anchor::commit_accounts;

pub fn commit(ctx: Context<Commit>) -> Result<()> {
    commit_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.state.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    Ok(())
}
```

### Undelegation

Returns PDA ownership to your program while committing final state.

```rust
#[commit]  // Handles commit + undelegate
pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
    Ok(())
}
```

## ER Validators (Devnet)

| Region | Validator Identity |
|--------|-------------------|
| Asia | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| EU | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| US | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| TEE | `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA` |

**Magic Router** (auto-selects best): `https://devnet-router.magicblock.app`

## Critical Rules

### DO:
- Maintain separate connections for base layer and ER
- Use `skipPreflight: true` for all ER transactions
- Verify delegation status before sending to ER
- Use `AccountInfo` for delegated accounts in Rust
- Match PDA seeds exactly between Rust and TypeScript

### DON'T:
- Send delegated account operations to base layer
- Mix base layer and ER operations in single transaction
- Assume account ownership without checking
- Skip commitment verification before base layer reads

## Products

| Product | Description |
|---------|-------------|
| **Ephemeral Rollup (ER)** | High-performance, gasless transactions |
| **Private ER (PER)** | Privacy-preserving computation with Intel TDX |
| **VRF** | Verifiable random function for on-chain randomness |
| **BOLT Framework** | ECS architecture for fully on-chain games |
| **Solana Plugins** | App-specific extensions for enhanced capabilities |

## Solana Plugins (New)

Solana Plugins are modular capabilities that can be added to your dApp to extend what's possible on Solana. Think of them as your custom toolkit: plug in what you need, when you need it.

### Available Plugins

| Plugin | Description | Use Cases |
|--------|-------------|-----------|
| **Verifiable Randomness (VRF)** | Provably fair on-chain randomness | Games, lotteries, NFT drops |
| **Real-Time Price Feeds** | Up-to-the-millisecond market data | DEXs, trading bots, DeFi |
| **AI Oracles** | Call AI models directly from smart contracts | Dynamic NFTs, AI agents |

### Using VRF Plugin

```typescript
import { requestRandomness, getRandomnessResult } from "@magicblock-labs/vrf-sdk";

// Request randomness
const requestTx = await requestRandomness({
  payer: wallet.publicKey,
  seed: Buffer.from("my_game_seed"),
});

// Get result after confirmation
const result = await getRandomnessResult(requestId);
console.log("Random value:", result.randomness);
```

### Privacy with Intel TDX

MagicBlock enables privacy in any Solana program state account through Ephemeral Rollups running in Trusted Execution Environments (TEE) on Intel TDX. This allows:
- Private computation without exposing state
- Verifiable execution guarantees
- Selective disclosure of results

## Resources

- **Documentation**: https://docs.magicblock.gg
- **GitHub**: https://github.com/magicblock-labs
- **Examples**: https://github.com/magicblock-labs/magicblock-engine-examples
- **Starter Kits**: https://github.com/magicblock-labs/starter-kits
- **BOLT Book**: https://book.boltengine.gg
- **Discord**: Join for testnet access

## Skill Structure

```
magicblock/
├── SKILL.md                          # This file
├── resources/
│   ├── api-reference.md              # Complete API reference
│   └── program-ids.md                # All program IDs and constants
├── examples/
│   ├── anchor-counter/README.md      # Basic counter with delegation
│   ├── delegation-flow/README.md     # Full delegation lifecycle
│   ├── vrf-randomness/README.md      # VRF integration
│   └── crank-automation/README.md    # Scheduled tasks
├── templates/
│   ├── program-template.rs           # Rust program starter
│   └── client-template.ts            # TypeScript client starter
└── docs/
    ├── advanced-patterns.md          # Complex patterns
    └── troubleshooting.md            # Common issues
```
