---
name: raydium
creator: raunit-dev
description: Complete Raydium Protocol SDK - the single source of truth for integrating Raydium on Solana. Covers SDK, Trade API, CLMM, CPMM, AMM pools, LaunchLab token launches, farming, CPI integration, and all Raydium tools.
---

# Raydium Protocol - Complete Integration Guide

The definitive guide for integrating Raydium - Solana's leading AMM and liquidity infrastructure powering DeFi since 2021.

## What is Raydium?

Raydium is a decentralized exchange on Solana providing:
- **Token Swapping** - Fast, cheap swaps via smart routing across all pool types
- **Liquidity Provision** - Earn trading fees and rewards by providing liquidity
- **Token Launches** - LaunchLab for permissionless token launches with bonding curves
- **Perpetual Trading** - Leverage trading on crypto assets

### Key Statistics
- Most widely integrated liquidity infrastructure on Solana
- 35,000+ tokens launched via LaunchLab (2025)
- Multiple pool types for different use cases

## Core Products

### Pool Types
| Type | Description | Best For |
|------|-------------|----------|
| **CLMM** | Concentrated Liquidity Market Maker | Professional LPs, stablecoin pairs, active management |
| **CPMM** | Constant Product (x*y=k) with Token22 | New token launches, simple integrations |
| **AMM V4** | Classic AMM + OpenBook CLOB | Existing markets, hybrid liquidity |

### Additional Features
- **LaunchLab** - Permissionless token launches with bonding curves
- **Farms** - Yield farming and staking rewards
- **Burn & Earn** - Permanent liquidity locking
- **Trade API** - HTTP API for swap routing

## API Overview

### 1. SDK (TypeScript)
**Package:** `@raydium-io/raydium-sdk-v2`

For programmatic integration with full control over pools, positions, and transactions.

### 2. Trade API (HTTP)
**Base URL:** `https://transaction-v1.raydium.io`

For swap routing - get quotes and serialized transactions via HTTP.

### 3. Data API
**Base URL:** `https://api-v3.raydium.io`

For pool data, token lists, farm info, and configurations.

## Quick Start

### Installation

```bash
npm install @raydium-io/raydium-sdk-v2
# or
yarn add @raydium-io/raydium-sdk-v2
```

### Basic Setup

```typescript
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Setup connection and wallet
const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

// Initialize SDK
const raydium = await Raydium.load({
  connection,
  owner,
  cluster: 'mainnet',
  disableLoadToken: false, // Load token list
});

// Access token data
const tokenList = raydium.token.tokenList;
const tokenMap = raydium.token.tokenMap;

// Access account data
const tokenAccounts = raydium.account.tokenAccounts;
```

## Pool Types

### CLMM (Concentrated Liquidity)

Allows LPs to concentrate liquidity in specific price ranges for higher capital efficiency.

```typescript
// Fetch CLMM pool
const poolId = 'POOL_ID_HERE';
const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);

// Or from API (mainnet only)
const poolData = await raydium.api.fetchPoolById({ ids: poolId });
```

### CPMM (Constant Product)

Simplified AMM without OpenBook market requirement, supports Token22.

```typescript
// Fetch CPMM pool
const cpmmPool = await raydium.cpmm.getPoolInfoFromRpc(poolId);
```

### AMM (Legacy)

Classic AMM integrated with OpenBook central limit order book.

```typescript
// Fetch AMM pool
const ammPool = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
```

## Core Operations

### Swap

```typescript
import { CurveCalculator } from '@raydium-io/raydium-sdk-v2';

// Calculate swap
const { amountOut, fee } = CurveCalculator.swapBaseInput({
  poolInfo,
  amountIn: 1000000n, // lamports
  mintIn: inputMint,
  mintOut: outputMint,
});

// Execute CPMM swap
const { execute } = await raydium.cpmm.swap({
  poolInfo,
  inputAmount: 1000000n,
  inputMint,
  slippage: 0.01, // 1%
  txVersion: 'V0',
});

await execute({ sendAndConfirm: true });
```

### Add Liquidity

```typescript
// CPMM deposit
const { execute } = await raydium.cpmm.addLiquidity({
  poolInfo,
  inputAmount: 1000000n,
  baseIn: true,
  slippage: 0.01,
});

await execute({ sendAndConfirm: true });
```

### Create Pool

```typescript
// Create CPMM pool
const { execute } = await raydium.cpmm.createPool({
  mintA,
  mintB,
  mintAAmount: 1000000n,
  mintBAmount: 1000000n,
  startTime: new BN(0),
  feeConfig, // from API
  txVersion: 'V0',
});

const { txId } = await execute({ sendAndConfirm: true });
```

## Program IDs

| Program | Mainnet | Devnet |
|---------|---------|--------|
| AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | `DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav` |
| CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | `devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH` |
| CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW` |

## API Endpoints

```typescript
// Mainnet API
const API_URL = 'https://api-v3.raydium.io';

// Devnet API
const DEVNET_API = 'https://api-v3.raydium.io/main/';

// Common endpoints
const endpoints = {
  tokenList: '/mint/list',
  poolList: '/pools/info/list',
  poolById: '/pools/info/ids',
  farmList: '/farms/info/list',
  clmmConfigs: '/clmm/configs',
};
```

## Transaction Options

```typescript
const { execute } = await raydium.cpmm.swap({
  poolInfo,
  inputAmount,
  inputMint,
  slippage: 0.01,
  txVersion: 'V0', // or 'LEGACY'
  computeBudgetConfig: {
    units: 600000,
    microLamports: 100000, // priority fee
  },
});

// Execute with options
const { txId } = await execute({
  sendAndConfirm: true,
  skipPreflight: true,
});

console.log(`https://solscan.io/tx/${txId}`);
```

## Key Features

| Feature | CLMM | CPMM | AMM |
|---------|------|------|-----|
| Concentrated Liquidity | Yes | No | No |
| Token22 Support | Limited | Yes | No |
| OpenBook Required | No | No | Yes |
| Custom Price Ranges | Yes | No | No |
| LP NFT Positions | Yes | No | No |

## LaunchLab (New)

LaunchLab simplifies token launches on Solana with customizable bonding curves:

```typescript
// Create token with bonding curve via LaunchLab
const { execute } = await raydium.launchLab.createToken({
  name: "My Token",
  symbol: "MTK",
  uri: "https://arweave.net/metadata.json",
  initialSupply: 1_000_000_000n,
  bondingCurve: "linear", // or "exponential"
  graduationThreshold: 85_000_000_000n, // 85 SOL
  txVersion: "V0",
});

const { txId } = await execute({ sendAndConfirm: true });
```

### Bonding Curve Migration

Tokens automatically migrate to AMM pools once they hit the graduation threshold (default: 85 SOL). Creators earn 10% of trading fees post-migration.

### Key Milestones (2025)
- **35,000+** tokens launched via LaunchLab
- **Orb Explorer** launched for on-chain analytics

## V3 Protocol (Coming)

Raydium V3 introduces a hybrid liquidity model combining:
- AMM pools with OpenBook's decentralized order book
- Access to **40% more liquidity** across Solana DeFi
- Enhanced capital efficiency for LPs

## Resources

- **SDK**: https://github.com/raydium-io/raydium-sdk-V2
- **Demos**: https://github.com/raydium-io/raydium-sdk-V2-demo
- **IDL**: https://github.com/raydium-io/raydium-idl
- **CLMM Program**: https://github.com/raydium-io/raydium-clmm
- **CPMM Program**: https://github.com/raydium-io/raydium-cp-swap
- **AMM Program**: https://github.com/raydium-io/raydium-amm
- **CPI Examples**: https://github.com/raydium-io/raydium-cpi

## Skill Structure

```
raydium/
├── SKILL.md                      # This file - complete integration guide
├── resources/
│   ├── sdk-api-reference.md      # Complete SDK API
│   ├── trade-api.md              # HTTP Trade API reference
│   ├── program-ids.md            # All program addresses
│   ├── pool-types.md             # Pool type comparison
│   ├── launchlab.md              # LaunchLab documentation
│   └── github-repos.md           # GitHub repositories reference
├── examples/
│   ├── swap/README.md            # Token swap examples
│   ├── clmm-pool/README.md       # CLMM pool creation
│   ├── clmm-position/README.md   # CLMM position management
│   ├── cpmm-pool/README.md       # CPMM pool operations
│   ├── liquidity/README.md       # Liquidity management
│   ├── farming/README.md         # Farming and staking
│   └── launchlab/README.md       # LaunchLab token launches
├── templates/
│   └── raydium-setup.ts          # SDK setup template
└── docs/
    ├── clmm-guide.md             # CLMM deep dive
    └── troubleshooting.md        # Common issues
```

## GitHub Repositories

| Repository | Description |
|------------|-------------|
| [raydium-sdk-V2](https://github.com/raydium-io/raydium-sdk-V2) | TypeScript SDK |
| [raydium-sdk-V2-demo](https://github.com/raydium-io/raydium-sdk-V2-demo) | SDK examples |
| [raydium-clmm](https://github.com/raydium-io/raydium-clmm) | CLMM program (Rust) |
| [raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) | CPMM program (Rust) |
| [raydium-amm](https://github.com/raydium-io/raydium-amm) | AMM V4 program (Rust) |
| [raydium-cpi](https://github.com/raydium-io/raydium-cpi) | CPI integration examples |
| [raydium-idl](https://github.com/raydium-io/raydium-idl) | IDL definitions |
