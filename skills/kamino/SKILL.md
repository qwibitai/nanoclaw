---
name: kamino
description: Complete guide for Kamino Finance - Solana's leading DeFi protocol for lending, borrowing, liquidity management, and leverage trading. Covers klend-sdk (lending), kliquidity-sdk (automated liquidity strategies), scope-sdk (oracle aggregator), multiply/leverage operations, vaults, and obligation orders.
---

# Kamino Finance Development Guide

Build sophisticated DeFi applications on Solana with Kamino Finance - the comprehensive DeFi protocol offering lending, borrowing, automated liquidity management, leverage trading, and oracle aggregation.

## Overview

Kamino Finance provides:
- **Kamino Lend (K-Lend)**: Lending and borrowing protocol with isolated markets
- **Kamino Liquidity (K-Liquidity)**: Automated CLMM liquidity management strategies
- **Scope Oracle**: Oracle price aggregator for reliable pricing
- **Multiply/Leverage**: Leveraged long/short positions on assets
- **Vaults**: Yield-generating vault strategies
- **Obligation Orders**: Automated LTV-based and price-based order execution

## Quick Start

### Installation

```bash
# Lending SDK
npm install @kamino-finance/klend-sdk

# Liquidity SDK
npm install @kamino-finance/kliquidity-sdk

# Oracle SDK
npm install @kamino-finance/scope-sdk

# Required peer dependencies
npm install @solana/web3.js @coral-xyz/anchor decimal.js
```

### Environment Setup

```bash
# .env file
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_KEYPAIR_PATH=./keypair.json
```

## Kamino Lending (klend-sdk)

The lending SDK enables interaction with Kamino's lending markets for deposits, borrows, repayments, and liquidations.

### Core Classes

| Class | Purpose |
|-------|---------|
| `KaminoMarket` | Load and interact with lending markets |
| `KaminoAction` | Build lending transactions (deposit, borrow, repay, withdraw) |
| `KaminoObligation` | Manage user obligations (positions) |
| `KaminoReserve` | Access reserve configurations and stats |
| `VanillaObligation` | Standard obligation type |

### Initialize Market

```typescript
import { KaminoMarket } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");

// Main lending market address
const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

// Load market with basic data
const market = await KaminoMarket.load(connection, MAIN_MARKET);

// Load reserves for detailed data
await market.loadReserves();

// Get specific reserve
const usdcReserve = market.getReserve("USDC");
console.log("Total Deposits:", usdcReserve?.stats.totalDepositsWads.toString());
console.log("LTV:", usdcReserve?.stats.loanToValueRatio);
console.log("Borrow APY:", usdcReserve?.stats.borrowInterestAPY);
console.log("Supply APY:", usdcReserve?.stats.supplyInterestAPY);

// Refresh all data including obligations
await market.refreshAll();
```

### Deposit Collateral

```typescript
import { KaminoAction, VanillaObligation, PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import Decimal from "decimal.js";

async function deposit(
  market: KaminoMarket,
  wallet: Keypair,
  tokenSymbol: string,
  amount: Decimal
) {
  // Build deposit transaction
  const kaminoAction = await KaminoAction.buildDepositTxns(
    market,
    amount.toString(),           // Amount in base units
    tokenSymbol,                  // e.g., "USDC", "SOL"
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    0,                            // Additional compute budget (optional)
    true,                         // Include Ata init instructions
    undefined,                    // Referrer (optional)
    undefined,                    // Current slot (optional)
    "finalized"                   // Commitment
  );

  // Get all instructions
  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  // Create and send transaction
  const tx = new Transaction().add(...instructions);
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);

  return signature;
}
```

### Borrow Assets

```typescript
async function borrow(
  market: KaminoMarket,
  wallet: Keypair,
  tokenSymbol: string,
  amount: Decimal
) {
  const kaminoAction = await KaminoAction.buildBorrowTxns(
    market,
    amount.toString(),
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    0,
    true,
    false,                        // Include deposit for fees (optional)
    undefined,
    undefined,
    "finalized"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Repay Loan

```typescript
async function repay(
  market: KaminoMarket,
  wallet: Keypair,
  tokenSymbol: string,
  amount: Decimal | "max"
) {
  const repayAmount = amount === "max" ? "max" : amount.toString();

  const kaminoAction = await KaminoAction.buildRepayTxns(
    market,
    repayAmount,
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    0,
    true,
    undefined,
    "finalized"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Withdraw Collateral

```typescript
async function withdraw(
  market: KaminoMarket,
  wallet: Keypair,
  tokenSymbol: string,
  amount: Decimal | "max"
) {
  const withdrawAmount = amount === "max" ? "max" : amount.toString();

  const kaminoAction = await KaminoAction.buildWithdrawTxns(
    market,
    withdrawAmount,
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    0,
    true,
    undefined,
    "finalized"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Get User Obligations

```typescript
// Get single vanilla obligation for user
const obligation = await market.getUserVanillaObligation(wallet.publicKey);

if (obligation) {
  console.log("Deposits:", obligation.state.deposits);
  console.log("Borrows:", obligation.state.borrows);
  console.log("Health Factor:", obligation.refreshedStats.borrowLimit);
}

// Get all obligations for user
const allObligations = await market.getAllUserObligations(wallet.publicKey);

// Get obligations for specific reserve
const reserveObligations = await market.getAllUserObligationsForReserve(
  wallet.publicKey,
  usdcReserve
);

// Check if reserve is part of obligation
const isReserveInObligation = market.isReserveInObligation(
  obligation,
  usdcReserve
);
```

### Liquidation

```typescript
async function liquidate(
  market: KaminoMarket,
  liquidator: Keypair,
  obligationOwner: PublicKey,
  repayTokenSymbol: string,
  withdrawTokenSymbol: string,
  repayAmount: Decimal
) {
  const kaminoAction = await KaminoAction.buildLiquidateTxns(
    market,
    repayAmount.toString(),
    repayTokenSymbol,
    withdrawTokenSymbol,
    obligationOwner,
    liquidator.publicKey,
    new VanillaObligation(PROGRAM_ID),
    0,
    true,
    "finalized"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);
  return await sendAndConfirmTransaction(connection, tx, [liquidator]);
}
```

## Leverage/Multiply Operations

Kamino supports leveraged positions through the multiply feature.

### Open Leveraged Position

```typescript
import {
  getLeverageDepositIxns,
  getLeverageWithdrawIxns,
  calculateLeverageMultiplier
} from "@kamino-finance/klend-sdk/leverage";

async function openLeveragedPosition(
  market: KaminoMarket,
  wallet: Keypair,
  collateralToken: string,
  borrowToken: string,
  depositAmount: Decimal,
  targetLeverage: number  // e.g., 2x, 3x
) {
  // Calculate parameters for target leverage
  const leverageParams = await calculateLeverageMultiplier(
    market,
    collateralToken,
    borrowToken,
    depositAmount,
    targetLeverage
  );

  // Build leverage deposit instructions
  const { instructions, lookupTables } = await getLeverageDepositIxns(
    market,
    wallet.publicKey,
    collateralToken,
    borrowToken,
    depositAmount,
    leverageParams,
    new VanillaObligation(PROGRAM_ID)
  );

  // Execute transaction with address lookup tables
  const tx = new VersionedTransaction(/* ... */);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Close Leveraged Position

```typescript
async function closeLeveragedPosition(
  market: KaminoMarket,
  wallet: Keypair,
  collateralToken: string,
  borrowToken: string
) {
  const { instructions, lookupTables } = await getLeverageWithdrawIxns(
    market,
    wallet.publicKey,
    collateralToken,
    borrowToken,
    "max",  // Withdraw full position
    new VanillaObligation(PROGRAM_ID)
  );

  const tx = new VersionedTransaction(/* ... */);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

## Obligation Orders

Automate actions based on LTV or price thresholds.

### LTV-Based Orders

```typescript
import {
  createLtvBasedOrder,
  LtvOrderType
} from "@kamino-finance/klend-sdk/obligation_orders";

// Create order to repay when LTV exceeds threshold
async function createLtvOrder(
  market: KaminoMarket,
  wallet: Keypair,
  targetLtv: number,  // e.g., 0.8 for 80%
  repayToken: string,
  repayAmount: Decimal
) {
  const orderIx = await createLtvBasedOrder(
    market,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    {
      type: LtvOrderType.REPAY_ON_HIGH_LTV,
      triggerLtv: targetLtv,
      repayToken,
      repayAmount: repayAmount.toString(),
    }
  );

  const tx = new Transaction().add(orderIx);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Price-Based Orders

```typescript
import {
  createPriceBasedOrder,
  PriceOrderType
} from "@kamino-finance/klend-sdk/obligation_orders";

// Create stop-loss order
async function createStopLossOrder(
  market: KaminoMarket,
  wallet: Keypair,
  tokenSymbol: string,
  triggerPrice: Decimal,
  action: "repay" | "withdraw"
) {
  const orderIx = await createPriceBasedOrder(
    market,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    {
      type: PriceOrderType.STOP_LOSS,
      tokenSymbol,
      triggerPrice: triggerPrice.toString(),
      action,
    }
  );

  const tx = new Transaction().add(orderIx);
  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

## Kamino Liquidity (kliquidity-sdk)

Automated liquidity management for concentrated liquidity positions on Orca, Raydium, and Meteora.

### Initialize SDK

```typescript
import { Kamino } from "@kamino-finance/kliquidity-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(clusterApiUrl("mainnet-beta"));
const kamino = new Kamino("mainnet-beta", connection);
```

### Fetch Strategies

```typescript
// Get all strategies
const strategies = await kamino.getStrategies();

// Get strategy by address
const strategy = await kamino.getStrategyByAddress(
  new PublicKey("strategy_address")
);

// Get strategy by kToken mint
const strategyByMint = await kamino.getStrategyByKTokenMint(
  new PublicKey("ktoken_mint")
);

// Get strategies with filters
const filteredStrategies = await kamino.getAllStrategiesWithFilters({
  strategyType: "NON_PEGGED",   // NON_PEGGED, PEGGED, STABLE
  status: "LIVE",               // LIVE, STAGING, DEPRECATED
  tokenA: new PublicKey("..."), // Filter by token A
  tokenB: new PublicKey("..."), // Filter by token B
});
```

### Strategy Types

| Type | Description | Example Pairs |
|------|-------------|---------------|
| `NON_PEGGED` | Uncorrelated assets | SOL-BONK, SOL-USDC |
| `PEGGED` | Loosely correlated | BSOL-JitoSOL, mSOL-SOL |
| `STABLE` | Price-stable | USDC-USDT, USDH-USDC |

### Get Strategy Data

```typescript
// Get share price
const sharePrice = await kamino.getStrategySharePrice(strategy);
console.log("Share Price:", sharePrice.toString());

// Get share data
const shareData = await kamino.getStrategyShareData(strategy);
console.log("Total Shares:", shareData.totalShares);
console.log("Token A per Share:", shareData.tokenAPerShare);
console.log("Token B per Share:", shareData.tokenBPerShare);

// Get token amounts per share
const tokenAmounts = await kamino.getTokenAAndBPerShare(strategy);
console.log("Token A:", tokenAmounts.tokenA);
console.log("Token B:", tokenAmounts.tokenB);

// Get strategy price range
const range = await kamino.getStrategyRange(strategy);
console.log("Lower Price:", range.lowerPrice);
console.log("Upper Price:", range.upperPrice);
console.log("Current Price:", range.currentPrice);
```

### Deposit to Strategy

```typescript
import Decimal from "decimal.js";

async function depositToStrategy(
  kamino: Kamino,
  wallet: Keypair,
  strategyAddress: PublicKey,
  tokenAAmount: Decimal,
  tokenBAmount: Decimal,
  slippage: Decimal  // e.g., new Decimal(0.01) for 1%
) {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  // Build deposit instructions
  const depositIxs = await kamino.deposit(
    strategy,
    wallet.publicKey,
    tokenAAmount,
    tokenBAmount,
    slippage
  );

  // Create transaction with extra compute budget
  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(...depositIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Single Token Deposit

```typescript
async function singleTokenDeposit(
  kamino: Kamino,
  wallet: Keypair,
  strategyAddress: PublicKey,
  tokenAmount: Decimal,
  isTokenA: boolean,  // true for Token A, false for Token B
  slippage: Decimal
) {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  const depositIxs = await kamino.singleTokenDeposit(
    strategy,
    wallet.publicKey,
    tokenAmount,
    isTokenA,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(...depositIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Withdraw from Strategy

```typescript
async function withdrawFromStrategy(
  kamino: Kamino,
  wallet: Keypair,
  strategyAddress: PublicKey,
  shareAmount: Decimal,  // Number of shares to withdraw
  slippage: Decimal
) {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  const withdrawIxs = await kamino.withdraw(
    strategy,
    wallet.publicKey,
    shareAmount,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(...withdrawIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}

// Withdraw all shares
async function withdrawAllShares(
  kamino: Kamino,
  wallet: Keypair,
  strategyAddress: PublicKey,
  slippage: Decimal
) {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  const withdrawIxs = await kamino.withdrawAllShares(
    strategy,
    wallet.publicKey,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(...withdrawIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Collect Fees & Rewards

```typescript
async function collectFeesAndRewards(
  kamino: Kamino,
  wallet: Keypair,
  strategyAddress: PublicKey
) {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  const collectIxs = await kamino.collectFeesAndRewards(
    strategy,
    wallet.publicKey
  );

  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(...collectIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

### Get Pool Information

```typescript
// Get supported DEXes
const dexes = kamino.getSupportedDexes();
// Returns: ["ORCA", "RAYDIUM", "METEORA"]

// Get fee tiers for DEX
const feeTiers = kamino.getFeeTiersForDex("ORCA");

// Get pools for token pair
const orcaPools = await kamino.getOrcaPoolsForTokens(tokenAMint, tokenBMint);
const raydiumPools = await kamino.getRaydiumPoolsForTokens(tokenAMint, tokenBMint);
const meteoraPools = await kamino.getMeteoraPoolsForTokens(tokenAMint, tokenBMint);

// Get current price for pair
const price = await kamino.getPriceForPair("ORCA", tokenAMint, tokenBMint);
```

### Rebalance Methods

```typescript
// Get available rebalance methods
const methods = kamino.getRebalanceMethods();
// Returns: ["MANUAL", "DRIFT", "TAKE_PROFIT", "PERIODIC", "PRICE_PERCENTAGE", ...]

// Get enabled methods
const enabledMethods = kamino.getEnabledRebalanceMethods();

// Get default method
const defaultMethod = kamino.getDefaultRebalanceMethod();

// Read rebalance parameters for strategy
const driftParams = await kamino.readDriftRebalanceParams(strategy);
const periodicParams = await kamino.readPeriodicRebalanceParams(strategy);
const priceParams = await kamino.readPricePercentageParams(strategy);
```

### Create New Strategy

```typescript
async function createStrategy(
  kamino: Kamino,
  admin: Keypair,
  params: {
    dex: "ORCA" | "RAYDIUM" | "METEORA";
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    feeTierBps: Decimal;
    rebalanceMethod: string;
  }
) {
  const strategyKeypair = Keypair.generate();

  // Check token accounts exist
  const tokenAAccount = await kamino.getAssociatedTokenAddressAndData(
    params.tokenAMint,
    admin.publicKey
  );
  const tokenBAccount = await kamino.getAssociatedTokenAddressAndData(
    params.tokenBMint,
    admin.publicKey
  );

  // Create strategy account
  const createAccountIx = await kamino.createStrategyAccount(
    strategyKeypair.publicKey
  );

  // Initialize strategy
  const initIxs = await kamino.initializeStrategy(
    strategyKeypair.publicKey,
    admin.publicKey,
    params
  );

  const tx = kamino.createTransactionWithExtraBudget();
  tx.add(createAccountIx, ...initIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  return await sendAndConfirmTransaction(
    connection,
    tx,
    [admin, strategyKeypair],
    { commitment: "finalized" }
  );
}
```

## Scope Oracle (scope-sdk)

Oracle price aggregator providing reliable pricing data.

### Initialize Scope

```typescript
import { Scope } from "@kamino-finance/scope-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(clusterApiUrl("mainnet-beta"));
const scope = new Scope("mainnet-beta", connection);
```

### Get Oracle Prices

```typescript
// Get all oracle prices
const prices = await scope.getOraclePrices();

// Prices indexed by token
console.log("SOL Price:", prices.get("SOL"));
console.log("USDC Price:", prices.get("USDC"));

// Get specific price
const solPrice = await scope.getPrice("SOL");
console.log("SOL/USD:", solPrice.price.toString());
console.log("Timestamp:", solPrice.timestamp);
console.log("Confidence:", solPrice.confidence);
```

### Price Feeds

Scope aggregates from multiple oracle sources:
- **Pyth**: Real-time market prices
- **Switchboard**: Decentralized oracle network
- **TWAP**: Time-weighted average prices
- **CLMM Prices**: DEX-derived prices

```typescript
// Get price with source info
const priceData = await scope.getPriceWithMetadata("SOL");
console.log("Price:", priceData.price);
console.log("Source:", priceData.source);
console.log("Age (slots):", priceData.ageSlots);
```

## CLI Commands

### Lending CLI

```bash
# Deposit tokens
yarn cli deposit --url <RPC> --owner ./keypair.json --token USDC --amount 100

# Print all lending market accounts
yarn cli print-all-lending-market-accounts --rpc <RPC>

# Print all reserve accounts
yarn cli print-all-reserve-accounts --rpc <RPC>

# Print all obligation accounts
yarn cli print-all-obligation-accounts --rpc <RPC>

# Filter with jq
yarn cli print-all-reserve-accounts --rpc <RPC> | jq '.lastUpdateSlot'
yarn cli print-all-obligation-accounts --rpc <RPC> | jq --stream 'select(.[0][1] == "owner")'
```

## Program Addresses

### Mainnet

| Program | Address |
|---------|---------|
| Kamino Lending | `KLend2g3cP87ber41qQDzWpAFuqP2tCxDqC8S3k7L1U` |
| Main Market | `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` |
| Kamino Liquidity | `KLIQ... (varies)` |
| Scope Oracle | `ScopE... (varies)` |

## Reserve Configuration

Each reserve has configurable parameters:

```typescript
interface ReserveConfig {
  // Collateral configuration
  loanToValueRatio: number;        // Max borrowing power (e.g., 0.8 = 80%)
  liquidationThreshold: number;     // Liquidation trigger (e.g., 0.85 = 85%)
  liquidationBonus: number;         // Liquidator reward (e.g., 0.05 = 5%)

  // Interest rate model
  optimalUtilizationRate: number;   // Target utilization
  borrowRateCurve: {
    baseRate: number;
    optimalRate: number;
    maxRate: number;
  };

  // Fees
  protocolTakeRate: number;         // Protocol fee on interest
  hostFeeRate: number;              // Host integration fee

  // Limits
  depositLimit: number;             // Max deposits
  borrowLimit: number;              // Max borrows

  // Status
  depositEnabled: boolean;
  borrowEnabled: boolean;
  withdrawEnabled: boolean;
}
```

## Error Handling

```typescript
import { KaminoError, ErrorCode } from "@kamino-finance/klend-sdk";

try {
  await kaminoAction.execute();
} catch (error) {
  if (error instanceof KaminoError) {
    switch (error.code) {
      case ErrorCode.InsufficientCollateral:
        console.error("Not enough collateral for this borrow");
        break;
      case ErrorCode.BorrowLimitExceeded:
        console.error("Borrow limit reached for this reserve");
        break;
      case ErrorCode.LiquidationThresholdExceeded:
        console.error("Position is at risk of liquidation");
        break;
      case ErrorCode.InvalidObligation:
        console.error("Obligation account not found or invalid");
        break;
      default:
        console.error("Kamino error:", error.message);
    }
  } else {
    throw error;
  }
}
```

## Best Practices

### Health Factor Monitoring

```typescript
async function checkHealthFactor(
  market: KaminoMarket,
  wallet: PublicKey
): Promise<number> {
  await market.refreshAll();
  const obligation = await market.getUserVanillaObligation(wallet);

  if (!obligation) return Infinity;

  const stats = obligation.refreshedStats;
  const healthFactor = stats.borrowLimit / stats.borrowedValue;

  if (healthFactor < 1.1) {
    console.warn("WARNING: Health factor below 1.1, consider adding collateral");
  }

  return healthFactor;
}
```

### Transaction Optimization

```typescript
// Use lookup tables for smaller transactions
const { instructions, lookupTables } = await kaminoAction.buildWithLookupTables();

// Create versioned transaction
const messageV0 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  instructions,
}).compileToV0Message(lookupTables);

const tx = new VersionedTransaction(messageV0);
tx.sign([wallet]);

await sendAndConfirmTransaction(connection, tx, [wallet]);
```

### Slippage Protection

```typescript
// For liquidity operations, always use slippage protection
const slippage = new Decimal(0.005); // 0.5% max slippage

const depositIxs = await kamino.deposit(
  strategy,
  wallet.publicKey,
  tokenAAmount,
  tokenBAmount,
  slippage  // Protects against price movement
);
```

## TypeScript Types

```typescript
import type {
  // Lending types
  KaminoMarket,
  KaminoAction,
  KaminoObligation,
  KaminoReserve,
  VanillaObligation,
  ReserveConfig,
  ObligationStats,

  // Liquidity types
  Kamino,
  WhirlpoolStrategy,
  StrategyWithAddress,
  ShareData,
  PositionRange,
  RebalanceMethod,
  StrategiesFilters,

  // Oracle types
  Scope,
  OraclePrices,
  PriceData,
} from "@kamino-finance/klend-sdk";
```

## Kamino 2.0 / K-Lend (New Features)

### Architecture Updates

Kamino 2.0 introduced a fully integrated application with two key layers:
- **Market Layer**: Core lending markets with advanced risk parameters
- **Vault Layer**: Curator-managed vault strategies for optimized yield

### New Collateral Support (2025)

| Asset | Type | Notes |
|-------|------|-------|
| **nxSOL** | LST | Nansen liquid staking token |
| **Huma RWA** | RWA | Real-world asset backed collateral |
| **JitoSOL** | LST | Jito liquid staking token |

### K-Lend V2 Features (Q4 2025)

- **Modular Lending**: Isolated markets for RWAs and institutional use cases
- **Enhanced Risk Engine**: Improved liquidation parameters
- **Multi-collateral Positions**: Borrow against multiple assets

### Governance (Q1 2026)

Decentralized decision-making via KMNO stakers will be activated, allowing token holders to vote on:
- Reserve parameters
- New market listings
- Protocol fees

## Security Milestones

- Fourth protocol verification completed (October 2025)
- $1.5M bug bounty program active

## Resources

- [Kamino Finance Website](https://kamino.finance)
- [Kamino Documentation](https://docs.kamino.finance)
- [klend-sdk GitHub](https://github.com/Kamino-Finance/klend-sdk)
- [kliquidity-sdk GitHub](https://github.com/Kamino-Finance/kliquidity-sdk)
- [scope-sdk GitHub](https://github.com/Kamino-Finance/scope-sdk)
- [farms-sdk GitHub](https://github.com/Kamino-Finance/farms-sdk)
- [Kamino Discord](https://discord.gg/kamino)

## Skill Structure

```
kamino/
├── SKILL.md                        # This file
├── resources/
│   ├── klend-api-reference.md      # Complete lending API
│   ├── kliquidity-api-reference.md # Complete liquidity API
│   ├── scope-api-reference.md      # Oracle API reference
│   ├── reserve-configs.md          # Reserve configurations
│   └── program-addresses.md        # All program addresses
├── examples/
│   ├── lending/
│   │   ├── deposit-withdraw.md     # Deposit & withdraw examples
│   │   ├── borrow-repay.md         # Borrowing examples
│   │   ├── leverage.md             # Multiply/leverage examples
│   │   └── liquidation.md          # Liquidation bot example
│   ├── liquidity/
│   │   ├── strategy-management.md  # Strategy operations
│   │   ├── deposits-withdrawals.md # LP operations
│   │   └── rebalancing.md          # Rebalance strategies
│   └── oracle/
│       └── price-feeds.md          # Oracle usage examples
├── templates/
│   ├── lending-setup.ts            # Lending starter
│   ├── liquidity-setup.ts          # Liquidity starter
│   └── full-integration.ts         # Complete integration
└── docs/
    ├── troubleshooting.md          # Common issues
    └── advanced-patterns.md        # Complex patterns
```
