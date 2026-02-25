---
name: meteora
description: Complete Meteora DeFi SDK suite for building liquidity pools, AMMs, bonding curves, vaults, token launches, and zap operations on Solana. Use when integrating DLMM, DAMM v2, DAMM v1, Dynamic Bonding Curves, Alpha Vaults, Zap, or Stake-for-Fee functionality.
---

# Meteora Protocol Development Guide

A comprehensive guide for building Solana DeFi applications with Meteora's suite of SDKs - the leading liquidity infrastructure on Solana.

## What is Meteora?

Meteora is Solana's premier liquidity layer, powering the infrastructure that connects liquidity providers (LPs), token launchers, and traders. It offers:

- **$2B+ Total Value Locked** across all protocols
- **Multiple AMM Types** - DLMM (concentrated), DAMM v2/v1 (constant product)
- **Token Launch Infrastructure** - Dynamic Bonding Curves, Alpha Vault anti-bot protection
- **Yield Optimization** - Dynamic Vaults, Stake-for-Fee (M3M3)
- **Developer Tools** - TypeScript/Go SDKs, CLI tools, Zap for single-token entry

### Why Use Meteora?

| Feature | Benefit |
|---------|---------|
| **Low Pool Creation Cost** | 0.022 SOL (vs 0.25+ SOL on competitors) |
| **Dynamic Fees** | Volatility-adjusted fees maximize LP returns |
| **Anti-Snipe Protection** | Fee schedulers and Alpha Vault prevent bot exploitation |
| **Token-2022 Support** | Full Token Extensions compatibility |
| **Permissionless** | Create pools, farms, and launches without approval |
| **Auto-Graduation** | Bonding curves auto-migrate to AMM pools |

## Overview

Meteora provides a complete DeFi infrastructure stack on Solana:

- **DLMM (Dynamic Liquidity Market Maker)**: Concentrated liquidity with dynamic fees
- **DAMM v2 (Dynamic AMM)**: Next-generation constant product AMM with position NFTs
- **DAMM v1 (Legacy AMM)**: Original constant product AMM with stable/weighted pools
- **Dynamic Bonding Curve**: Customizable token launch curves with auto-graduation
- **Dynamic Vault**: Yield-optimized token vaults
- **Alpha Vault**: Anti-bot protection for token launches
- **Stake-for-Fee (M3M3)**: Staking rewards from trading fees
- **Zap SDK**: Single-token entry/exit for liquidity positions
- **Presale Vault** *(Beta)*: Token presale infrastructure

## Quick Start

### Installation

```bash
# DLMM SDK - Concentrated liquidity
npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js

# DAMM v2 SDK - Next-gen constant product AMM
npm install @meteora-ag/cp-amm-sdk @solana/web3.js

# DAMM v1 SDK - Legacy AMM (stable pools, weighted pools)
npm install @meteora-ag/dynamic-amm @solana/web3.js @coral-xyz/anchor

# Dynamic Bonding Curve SDK - Token launches
npm install @meteora-ag/dynamic-bonding-curve-sdk

# Vault SDK - Yield optimization
npm install @meteora-ag/vault-sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token

# Alpha Vault SDK - Anti-bot protection
npm install @meteora-ag/alpha-vault

# Stake-for-Fee (M3M3) SDK - Fee staking
npm install @meteora-ag/m3m3 @coral-xyz/anchor @solana/web3.js @solana/spl-token

# Zap SDK - Single-token entry/exit (requires Jupiter API key)
npm install @meteora-ag/zap-sdk

# Pool Farms SDK - Farm creation and staking
npm install @meteora-ag/farming
```

### Program Addresses

| Program | Mainnet/Devnet Address |
|---------|------------------------|
| DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DAMM v1 | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` |
| Dynamic Bonding Curve | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Dynamic Vault | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` |
| Stake-for-Fee | `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP` |
| Zap | `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz` |

---

## DLMM SDK (Dynamic Liquidity Market Maker)

The DLMM SDK provides programmatic access to Meteora's concentrated liquidity protocol with dynamic fees based on volatility.

### Basic Setup

```typescript
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const poolAddress = new PublicKey('POOL_ADDRESS');

// Create DLMM instance for existing pool
const dlmm = await DLMM.create(connection, poolAddress);

// Create multiple pools
const dlmmPools = await DLMM.createMultiple(connection, [pool1, pool2, pool3]);
```

### Core Operations

#### Get Active Bin (Current Price)

```typescript
const activeBin = await dlmm.getActiveBin();
console.log('Active Bin ID:', activeBin.binId);
console.log('Price:', activeBin.price);
console.log('X Amount:', activeBin.xAmount.toString());
console.log('Y Amount:', activeBin.yAmount.toString());
```

#### Price and Bin Conversions

```typescript
// Get price from bin ID
const price = dlmm.getPriceOfBinByBinId(binId);

// Get bin ID from price
const binId = dlmm.getBinIdFromPrice(price, true); // true = round down

// Convert to/from lamport representation
const lamportPrice = dlmm.toPricePerLamport(21.23);
const realPrice = dlmm.fromPricePerLamport(lamportPrice);

// Get bins in a range
const bins = await dlmm.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId);

// Get bins around active bin
const surroundingBins = await dlmm.getBinsAroundActiveBin(10); // 10 bins each side
```

#### Swap Operations

```typescript
import { BN } from '@coral-xyz/anchor';

// Get swap quote
const swapAmount = new BN(1_000_000); // 1 USDC (6 decimals)
const swapForY = true; // Swap X for Y
const slippageBps = 100; // 1% slippage

const binArrays = await dlmm.getBinArrayForSwap(swapForY);
const swapQuote = dlmm.swapQuote(swapAmount, swapForY, slippageBps, binArrays);

console.log('Amount In:', swapQuote.consumedInAmount.toString());
console.log('Amount Out:', swapQuote.outAmount.toString());
console.log('Min Amount Out:', swapQuote.minOutAmount.toString());
console.log('Price Impact:', swapQuote.priceImpact);
console.log('Fee:', swapQuote.fee.toString());

// Execute swap
const swapTx = await dlmm.swap({
  inToken: tokenXMint,
  outToken: tokenYMint,
  inAmount: swapAmount,
  minOutAmount: swapQuote.minOutAmount,
  lbPair: dlmm.pubkey,
  user: wallet.publicKey,
  binArraysPubkey: swapQuote.binArraysPubkey,
});

const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet]);
```

#### Liquidity Management

```typescript
import { StrategyType } from '@meteora-ag/dlmm';

// Get user positions
const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

// Initialize position and add liquidity with strategy
const newPositionTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
  positionPubKey: newPositionKeypair.publicKey,
  user: wallet.publicKey,
  totalXAmount: new BN(100_000_000), // 100 tokens
  totalYAmount: new BN(100_000_000),
  strategy: {
    maxBinId: activeBin.binId + 10,
    minBinId: activeBin.binId - 10,
    strategyType: StrategyType.SpotBalanced,
  },
});

// Add liquidity to existing position
const addLiquidityTx = await dlmm.addLiquidityByStrategy({
  positionPubKey: existingPosition.publicKey,
  user: wallet.publicKey,
  totalXAmount: new BN(50_000_000),
  totalYAmount: new BN(50_000_000),
  strategy: {
    maxBinId: activeBin.binId + 5,
    minBinId: activeBin.binId - 5,
    strategyType: StrategyType.SpotBalanced,
  },
});

// Remove liquidity
const removeLiquidityTx = await dlmm.removeLiquidity({
  position: position.publicKey,
  user: wallet.publicKey,
  binIds: position.positionData.positionBinData.map(b => b.binId),
  bps: new BN(10000), // 100% (basis points)
  shouldClaimAndClose: true,
});
```

#### Claim Fees and Rewards

```typescript
// Get claimable fees
const claimableFees = await DLMM.getClaimableSwapFee(connection, position.publicKey);
console.log('Claimable Fee X:', claimableFees.feeX.toString());
console.log('Claimable Fee Y:', claimableFees.feeY.toString());

// Get claimable LM rewards
const claimableRewards = await DLMM.getClaimableLMReward(connection, position.publicKey);

// Claim swap fees
const claimFeeTx = await dlmm.claimSwapFee({
  owner: wallet.publicKey,
  position: position.publicKey,
});

// Claim all fees from multiple positions
const claimAllFeesTx = await dlmm.claimAllSwapFee({
  owner: wallet.publicKey,
  positions: positions.map(p => p.publicKey),
});

// Claim LM rewards
const claimRewardTx = await dlmm.claimLMReward({
  owner: wallet.publicKey,
  position: position.publicKey,
});

// Claim all rewards
const claimAllTx = await dlmm.claimAllRewards({
  owner: wallet.publicKey,
  positions: positions.map(p => p.publicKey),
});
```

#### Position Strategies

```typescript
import { StrategyType } from '@meteora-ag/dlmm';

// Available strategies
StrategyType.SpotOneSide      // Single-sided liquidity at current price
StrategyType.CurveOneSide     // Curve distribution on one side
StrategyType.BidAskOneSide    // Bid/ask distribution on one side
StrategyType.SpotBalanced     // Balanced around current price
StrategyType.CurveBalanced    // Curve distribution around current price
StrategyType.BidAskBalanced   // Bid/ask distribution around current price
StrategyType.SpotImBalanced   // Imbalanced spot distribution
StrategyType.CurveImBalanced  // Imbalanced curve distribution
StrategyType.BidAskImBalanced // Imbalanced bid/ask distribution
```

---

## DAMM v2 SDK (CP-AMM)

The DAMM v2 SDK provides a comprehensive interface for Meteora's next-generation constant product AMM with significant improvements over V1.

### Key DAMM V2 Features (New in 2025)

| Feature | Description |
|---------|-------------|
| **Dynamic Fees** | Optional fee scheduler with anti-sniper mechanism |
| **Position NFTs** | LPs receive transferrable NFT instead of LP token |
| **Token2022 Support** | Full support for Token Extensions standard |
| **Locked Liquidity** | Built-in liquidity locking options |
| **Permissionless Farms** | Create farms without protocol approval |
| **Lower Costs** | Pool creation costs only 0.022 SOL (vs 0.25 SOL on old DLMM) |

### Fee Scheduler (Anti-Snipe)

The fee scheduler starts with high swap fees that taper over time, protecting against sniping:

```typescript
// Create pool with fee scheduler
const createPoolTx = await cpAmm.createCustomPool({
  // ... other params
  poolFees: {
    baseFee: {
      cliffFeeNumerator: new BN(10000000), // 1% initial fee
      numberOfPeriod: 10,
      reductionFactor: new BN(500000),     // Reduce by 0.05% each period
      periodFrequency: new BN(300),        // Every 5 minutes
      feeSchedulerMode: 1,                 // Linear reduction
    },
    // ...
  },
});
```

### Basic Setup

```typescript
import { Connection } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const cpAmm = new CpAmm(connection);
```

### Pool Management

#### Create Pool

```typescript
// Create standard pool from config
const createPoolTx = await cpAmm.createPool({
  creator: wallet.publicKey,
  configAddress: configPubkey,
  tokenAMint,
  tokenBMint,
  tokenAAmount: new BN(1_000_000_000),
  tokenBAmount: new BN(1_000_000_000),
});

// Create custom pool with specific parameters
const createCustomPoolTx = await cpAmm.createCustomPool({
  creator: wallet.publicKey,
  tokenAMint,
  tokenBMint,
  tokenAAmount: new BN(1_000_000_000),
  tokenBAmount: new BN(1_000_000_000),
  poolFees: {
    baseFee: {
      cliffFeeNumerator: new BN(2500000), // 0.25%
      numberOfPeriod: 0,
      reductionFactor: new BN(0),
      periodFrequency: new BN(0),
      feeSchedulerMode: 0,
    },
    dynamicFee: null,
    protocolFeePercent: 20,
    partnerFeePercent: 0,
    referralFeePercent: 20,
    dynamicFeeConfig: null,
  },
  hasAlphaVault: false,
  activationType: 0, // 0 = slot, 1 = timestamp
  activationPoint: null, // null = immediate
  collectFeeMode: 0,
});
```

#### Fetch Pool State

```typescript
// Fetch single pool
const poolState = await cpAmm.fetchPoolState(poolAddress);
console.log('Token A Vault:', poolState.tokenAVault.toString());
console.log('Token B Vault:', poolState.tokenBVault.toString());
console.log('Sqrt Price:', poolState.sqrtPrice.toString());
console.log('Liquidity:', poolState.liquidity.toString());

// Fetch all pools
const allPools = await cpAmm.getAllPools();

// Check if pool exists
const exists = await cpAmm.isPoolExist(tokenAMint, tokenBMint);
```

### Position Operations

#### Create and Manage Positions

```typescript
// Create position
const createPositionTx = await cpAmm.createPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
});

// Add liquidity
const addLiquidityTx = await cpAmm.addLiquidity({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  tokenAAmountIn: new BN(100_000_000),
  tokenBAmountIn: new BN(100_000_000),
  liquidityMin: new BN(0),
});

// Get deposit quote
const depositQuote = cpAmm.getDepositQuote({
  poolState,
  tokenAAmount: new BN(100_000_000),
  tokenBAmount: new BN(100_000_000),
  slippageBps: 100,
});

// Remove liquidity
const removeLiquidityTx = await cpAmm.removeLiquidity({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  liquidityAmount: new BN(50_000_000),
  tokenAAmountMin: new BN(0),
  tokenBAmountMin: new BN(0),
});

// Get withdraw quote
const withdrawQuote = cpAmm.getWithdrawQuote({
  poolState,
  positionState,
  liquidityAmount: new BN(50_000_000),
  slippageBps: 100,
});

// Merge positions
const mergePositionTx = await cpAmm.mergePosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  sourcePositions: [position1, position2],
  destinationPosition: destPosition,
});

// Split position
const splitPositionTx = await cpAmm.splitPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  percentage: 50, // Split 50%
  newPosition: newPositionKeypair.publicKey,
});
```

### Swapping

```typescript
import { SwapMode } from '@meteora-ag/cp-amm-sdk';

// Available swap modes
SwapMode.ExactIn     // Specify exact input amount
SwapMode.ExactOut    // Specify exact output amount
SwapMode.PartialFill // Allow partial fills

// Get swap quote
const quote = cpAmm.getQuote({
  poolState,
  inputTokenMint: tokenAMint,
  outputTokenMint: tokenBMint,
  amount: new BN(1_000_000),
  slippageBps: 100,
  swapMode: SwapMode.ExactIn,
});

console.log('Input Amount:', quote.inputAmount.toString());
console.log('Output Amount:', quote.outputAmount.toString());
console.log('Min Output:', quote.minimumOutputAmount.toString());
console.log('Price Impact:', quote.priceImpact);
console.log('Fee:', quote.fee.toString());

// Execute swap
const swapTx = await cpAmm.swap({
  payer: wallet.publicKey,
  pool: poolAddress,
  inputTokenMint: tokenAMint,
  outputTokenMint: tokenBMint,
  amountIn: new BN(1_000_000),
  minimumAmountOut: quote.minimumOutputAmount,
  referralAccount: null,
});
```

### Fee and Reward Management

```typescript
// Claim position fees
const claimFeeTx = await cpAmm.claimPositionFee({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
});

// Initialize reward (pool creator only)
const initRewardTx = await cpAmm.initializeReward({
  pool: poolAddress,
  rewardMint,
  rewardDuration: new BN(86400 * 7), // 7 days
  funder: wallet.publicKey,
});

// Fund reward
const fundRewardTx = await cpAmm.fundReward({
  pool: poolAddress,
  rewardMint,
  amount: new BN(1_000_000_000),
  funder: wallet.publicKey,
});

// Claim rewards
const claimRewardTx = await cpAmm.claimReward({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  rewardIndex: 0,
});
```

### Position Locking and Vesting

```typescript
// Lock position with vesting schedule
const lockPositionTx = await cpAmm.lockPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  vestingDuration: new BN(86400 * 30), // 30 days
  cliffDuration: new BN(86400 * 7),    // 7 day cliff
});

// Permanent lock (irreversible)
const permanentLockTx = await cpAmm.permanentLockPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  liquidityAmount: new BN(50_000_000), // Amount to permanently lock
});

// Refresh vesting (unlock available tokens)
const refreshVestingTx = await cpAmm.refreshVesting({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
});

// Check if position is locked
const isLocked = cpAmm.isLockedPosition(positionState);
```

### Helper Functions

```typescript
// Price conversions
const price = cpAmm.getPriceFromSqrtPrice(sqrtPrice, tokenADecimals, tokenBDecimals);
const sqrtPrice = cpAmm.getSqrtPriceFromPrice(price, tokenADecimals, tokenBDecimals);

// Fee conversions
const feeNumerator = cpAmm.bpsToFeeNumerator(25); // 0.25% = 25 bps
const bps = cpAmm.feeNumeratorToBps(feeNumerator);

// Slippage calculations
const minAmount = cpAmm.getAmountWithSlippage(amount, slippageBps, false);
const maxAmount = cpAmm.getMaxAmountWithSlippage(amount, slippageBps);

// Get price impact
const priceImpact = cpAmm.getPriceImpact(amountIn, amountOut, currentPrice);

// Get liquidity delta
const liquidityDelta = cpAmm.getLiquidityDelta({
  poolState,
  tokenAAmount: new BN(100_000_000),
  tokenBAmount: new BN(100_000_000),
});
```

---

## Dynamic Bonding Curve SDK

The Dynamic Bonding Curve SDK enables building customizable token launches with automatic graduation to DAMM.

### Basic Setup

```typescript
import { Connection } from '@solana/web3.js';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const dbc = new DynamicBondingCurve(connection, 'confirmed');
```

### Token Launch Flow

The DBC follows a 5-step progression:

1. **Partner Configuration**: Set up pool parameters
2. **Pool Creation**: Creator launches the bonding curve
3. **Trading Phase**: Users buy/sell on the curve
4. **Graduation**: Auto-migrate to DAMM v1 or v2 when threshold is met
5. **Post-Graduation**: Trade on the graduated AMM

### Create Pool with Bonding Curve

```typescript
// Create a new bonding curve pool
const createPoolTx = await dbc.createPool({
  creator: wallet.publicKey,
  baseMint: baseTokenMint,
  quoteMint: quoteTokenMint, // Usually SOL or USDC
  config: configAddress,
  baseAmount: new BN(1_000_000_000_000), // Total supply
  quoteAmount: new BN(0), // Initial quote (usually 0)
  name: 'My Token',
  symbol: 'MTK',
  uri: 'https://arweave.net/metadata.json',
});
```

### Trading on Bonding Curve

```typescript
// Get quote for buying tokens
const buyQuote = await dbc.getBuyQuote({
  pool: poolAddress,
  quoteAmount: new BN(1_000_000_000), // 1 SOL
});

console.log('Tokens to receive:', buyQuote.baseAmount.toString());
console.log('Price per token:', buyQuote.price.toString());

// Execute buy
const buyTx = await dbc.buy({
  payer: wallet.publicKey,
  pool: poolAddress,
  quoteAmount: new BN(1_000_000_000),
  minBaseAmount: buyQuote.minBaseAmount,
});

// Get quote for selling tokens
const sellQuote = await dbc.getSellQuote({
  pool: poolAddress,
  baseAmount: new BN(1_000_000), // Tokens to sell
});

// Execute sell
const sellTx = await dbc.sell({
  payer: wallet.publicKey,
  pool: poolAddress,
  baseAmount: new BN(1_000_000),
  minQuoteAmount: sellQuote.minQuoteAmount,
});
```

### Pool Graduation

```typescript
// Check graduation status
const poolState = await dbc.fetchPoolState(poolAddress);
const isGraduated = poolState.graduated;
const graduationThreshold = poolState.graduationThreshold;
const currentMarketCap = poolState.currentMarketCap;

// Manual migration to DAMM v2 (if auto-graduation not triggered)
const migrateTx = await dbc.migrateToDAMMV2({
  pool: poolAddress,
  payer: wallet.publicKey,
});

// For DAMM v1 migration (more steps required)
// 1. Create metadata
const createMetadataTx = await dbc.createMetadata({
  pool: poolAddress,
  payer: wallet.publicKey,
});

// 2. Execute migration
const migrateToDammV1Tx = await dbc.migrateToDAMMV1({
  pool: poolAddress,
  payer: wallet.publicKey,
});

// 3. Lock LP tokens (optional)
const lockLpTx = await dbc.lockLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
  lockDuration: new BN(86400 * 365), // 1 year
});

// 4. Claim LP tokens after lock expires
const claimLpTx = await dbc.claimLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
});
```

### Fee Configuration Options

The DBC supports multiple fee tier configurations:

| Tier | Fee (bps) | Use Case |
|------|-----------|----------|
| 1 | 25 | Standard launches |
| 2 | 50 | Community tokens |
| 3 | 100 | Meme tokens |
| 4 | 200 | High volatility |
| 5 | 400 | Experimental |
| 6 | 600 | Maximum protection |

---

## Dynamic Vault SDK

The Vault SDK provides yield-optimized token storage with automatic strategy management.

### Basic Setup

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { VaultImpl } from '@meteora-ag/vault-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const tokenMint = new PublicKey('TOKEN_MINT_ADDRESS');

// Create vault instance
const vault = await VaultImpl.create(connection, tokenMint);

// With affiliate ID (for partner integrations)
const vaultWithAffiliate = await VaultImpl.create(connection, tokenMint, {
  affiliateId: new PublicKey('PARTNER_KEY'),
});
```

### Vault Operations

```typescript
// Get vault information
const lpSupply = vault.lpSupply; // Or use vault.getVaultSupply() to refresh
const withdrawableAmount = await vault.getWithdrawableAmount();

console.log('Total LP Supply:', lpSupply.toString());
console.log('Locked Amount:', withdrawableAmount.locked.toString());
console.log('Unlocked Amount:', withdrawableAmount.unlocked.toString());

// Get user balance
const userLpBalance = await vault.getUserBalance(wallet.publicKey);

// Deposit tokens
const depositTx = await vault.deposit(wallet.publicKey, new BN(1_000_000_000));
await sendAndConfirmTransaction(connection, depositTx, [wallet]);

// Withdraw tokens
const withdrawTx = await vault.withdraw(wallet.publicKey, new BN(500_000_000));
await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
```

### Share Calculations

```typescript
import { getAmountByShare, getUnmintAmount } from '@meteora-ag/vault-sdk';

// Convert LP tokens to underlying amount
const underlyingAmount = getAmountByShare(
  userLpBalance,      // User's LP tokens
  unlockedAmount,     // Vault's unlocked balance
  lpSupply            // Total LP supply
);

// Calculate LP tokens needed for specific withdrawal
const lpNeeded = getUnmintAmount(
  targetWithdrawAmount, // Amount to withdraw
  unlockedAmount,       // Vault's unlocked balance
  lpSupply              // Total LP supply
);
```

### Affiliate Integration

```typescript
// Get affiliate info
const affiliateInfo = await vault.getAffiliateInfo();
console.log('Partner:', affiliateInfo.partner.toString());
console.log('Fee Rate:', affiliateInfo.feeRate);
console.log('Outstanding Fee:', affiliateInfo.outstandingFee.toString());
```

---

## Alpha Vault SDK

The Alpha Vault SDK provides anti-bot protection for token launches, ensuring fair distribution.

### Basic Setup

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { AlphaVault } from '@meteora-ag/alpha-vault';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const vaultAddress = new PublicKey('VAULT_ADDRESS');

const alphaVault = await AlphaVault.create(connection, vaultAddress);
```

### Vault Operations

```typescript
// Get vault state
const vaultState = await alphaVault.getVaultState();
console.log('Total Deposited:', vaultState.totalDeposited.toString());
console.log('Max Deposit:', vaultState.maxDeposit.toString());
console.log('Start Time:', vaultState.startTime.toString());
console.log('End Time:', vaultState.endTime.toString());

// Deposit to vault (during deposit window)
const depositTx = await alphaVault.deposit({
  payer: wallet.publicKey,
  amount: new BN(1_000_000_000), // 1 SOL
});

// Withdraw from vault (if allowed)
const withdrawTx = await alphaVault.withdraw({
  payer: wallet.publicKey,
  amount: new BN(500_000_000),
});

// Claim tokens (after launch)
const claimTx = await alphaVault.claimTokens({
  payer: wallet.publicKey,
});

// Get user allocation
const allocation = await alphaVault.getUserAllocation(wallet.publicKey);
console.log('Deposit Amount:', allocation.depositAmount.toString());
console.log('Token Allocation:', allocation.tokenAllocation.toString());
console.log('Claimed:', allocation.claimed);
```

---

## Stake-for-Fee SDK (M3M3)

The M3M3 SDK enables staking tokens to earn fees from trading activity.

### Basic Setup

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { StakeForFee } from '@meteora-ag/m3m3';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const poolAddress = new PublicKey('POOL_ADDRESS');

const m3m3 = await StakeForFee.create(connection, poolAddress);
```

### Staking Operations

```typescript
// Get user stake and claimable balance
const userBalance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
console.log('Staked Amount:', userBalance.stakedAmount.toString());
console.log('Claimable Fees:', userBalance.claimableFees.toString());

// Stake tokens
const stakeTx = await m3m3.stake(new BN(1_000_000_000), wallet.publicKey);
await sendAndConfirmTransaction(connection, stakeTx, [wallet]);

// Claim accumulated fees
const claimTx = await m3m3.claimFee(wallet.publicKey, null); // null = claim all
await sendAndConfirmTransaction(connection, claimTx, [wallet]);

// Initiate unstake (starts lock period)
const unstakeTx = await m3m3.unstake(
  new BN(500_000_000),
  destinationTokenAccount,
  wallet.publicKey
);

// Cancel pending unstake
const cancelUnstakeTx = await m3m3.cancelUnstake(escrowAddress, wallet.publicKey);

// Complete withdrawal (after lock period)
const withdrawTx = await m3m3.withdraw(escrowAddress, wallet.publicKey);

// Get unstake period
const unstakePeriod = m3m3.getUnstakePeriod(); // Duration in seconds

// Refresh states
await m3m3.refreshStates();
```

---

## DAMM v1 SDK (Legacy Dynamic AMM)

The DAMM v1 SDK is the original constant product AMM, still widely used for stable pools, weighted pools, and LST pools. While DAMM v2 is recommended for new pools, v1 remains fully supported.

### Basic Setup

```typescript
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import AmmImpl from '@meteora-ag/dynamic-amm';

const connection = new Connection('https://api.mainnet-beta.solana.com');

// Create pool instance
const pool = await AmmImpl.create(connection, new PublicKey('POOL_ADDRESS'));

// Or create multiple pools
const pools = await AmmImpl.createMultiple(connection, [poolAddress1, poolAddress2]);
```

### Pool Creation

```typescript
// Create permissionless constant product pool
const createPoolTx = await AmmImpl.createPermissionlessConstantProductPoolWithConfig(
  connection,
  wallet.publicKey,
  tokenAMint,
  tokenBMint,
  tokenAAmount,
  tokenBAmount,
  configAddress, // Fee configuration
  {
    lockLiquidity: false, // Lock initial liquidity
    activationPoint: null, // Optional delayed activation
  }
);

// Create memecoin pool (optimized for token launches)
const memePoolTx = await AmmImpl.createPermissionlessConstantProductMemecoinPoolWithConfig(
  connection,
  wallet.publicKey,
  tokenAMint,
  tokenBMint,
  tokenAAmount,
  tokenBAmount,
  configAddress,
  {
    lockLiquidity: true, // Lock liquidity for trust
  }
);
```

### Pool State Queries

```typescript
// Get LP token supply
const lpSupply = await pool.getLpSupply();

// Get user's LP token balance
const userBalance = await pool.getUserBalance(wallet.publicKey);

// Get swap quote
const swapQuote = pool.getSwapQuote(
  inputMint,
  inputAmount,
  slippageBps // 100 = 1%
);
console.log('Output amount:', swapQuote.outAmount.toString());
console.log('Fee:', swapQuote.fee.toString());
console.log('Price impact:', swapQuote.priceImpact);

// Get deposit quote
const depositQuote = pool.getDepositQuote(
  tokenAAmount,
  tokenBAmount,
  true, // balanced deposit
  slippageBps
);
console.log('LP tokens to receive:', depositQuote.lpAmount.toString());

// Get withdraw quote
const withdrawQuote = pool.getWithdrawQuote(
  lpAmount,
  slippageBps
);
console.log('Token A out:', withdrawQuote.tokenAAmount.toString());
console.log('Token B out:', withdrawQuote.tokenBAmount.toString());

// Refresh pool state
await pool.updateState();
```

### Liquidity Operations

```typescript
// Deposit liquidity
const depositTx = await pool.deposit(
  wallet.publicKey,
  tokenAAmount,
  tokenBAmount,
  lpAmountMin // Minimum LP tokens to receive
);

// Withdraw liquidity
const withdrawTx = await pool.withdraw(
  wallet.publicKey,
  lpAmount,
  tokenAMin, // Minimum token A to receive
  tokenBMin  // Minimum token B to receive
);
```

### Swapping

```typescript
// Execute swap
const swapTx = await pool.swap(
  wallet.publicKey,
  inputMint,
  inputAmount,
  minOutputAmount
);
```

### Pool Types

| Pool Type | Use Case | Features |
|-----------|----------|----------|
| **Constant Product** | General trading pairs | Standard x*y=k AMM |
| **Stable** | Stablecoin pairs (USDC/USDT) | Lower slippage for pegged assets |
| **Weighted** | Unbalanced pools (80/20) | Custom token weights |
| **LST** | Liquid staking tokens | Optimized for staking derivatives |

---

## Zap SDK

The Zap SDK enables single-token entry and exit for liquidity positions, automatically handling swaps through Jupiter or the pool's built-in routing.

### Basic Setup

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { Zap } from '@meteora-ag/zap-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');

// Jupiter API key is required (get from Jupiter Portal)
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const JUPITER_API_KEY = 'your-api-key';

const zap = new Zap(connection, JUPITER_API_URL, JUPITER_API_KEY);
```

### Zap Into DLMM Position

```typescript
// Zap single token into DLMM concentrated liquidity position
const zapInDlmmTx = await zap.zapInDlmm({
  user: wallet.publicKey,
  lbPairAddress: dlmmPoolAddress,
  inputMint: SOL_MINT,
  inputAmount: new BN(1_000_000_000), // 1 SOL
  slippageBps: 100, // 1%
  positionPubkey: positionAddress, // Existing or new position
  strategyType: 'SpotBalanced', // Distribution strategy
  minBinId: activeBinId - 10,
  maxBinId: activeBinId + 10,
});

await sendAndConfirmTransaction(connection, zapInDlmmTx, [wallet]);
```

### Zap Into DAMM v2 Position

```typescript
// Zap single token into DAMM v2 pool
const zapInDammV2Tx = await zap.zapInDammV2({
  user: wallet.publicKey,
  poolAddress: dammV2PoolAddress,
  inputMint: USDC_MINT,
  inputAmount: new BN(100_000_000), // 100 USDC
  slippageBps: 100,
  positionPubkey: positionAddress,
});

await sendAndConfirmTransaction(connection, zapInDammV2Tx, [wallet]);
```

### Zap Out Operations

```typescript
// Zap out from DLMM to single token
const zapOutDlmmTx = await zap.zapOutDlmm({
  user: wallet.publicKey,
  lbPairAddress: dlmmPoolAddress,
  outputMint: SOL_MINT, // Receive everything as SOL
  positionPubkey: positionAddress,
  percentageToZap: 100, // 100% of position
  slippageBps: 100,
});

// Zap out from DAMM v2 to single token
const zapOutDammV2Tx = await zap.zapOutDammV2({
  user: wallet.publicKey,
  poolAddress: dammV2PoolAddress,
  outputMint: USDC_MINT,
  positionPubkey: positionAddress,
  percentageToZap: 50, // 50% of position
  slippageBps: 100,
});
```

### Zap Through Jupiter

```typescript
// Get Jupiter quote for optimal routing
const jupiterQuote = await zap.getJupiterQuote({
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amount: new BN(1_000_000_000),
  slippageBps: 50,
});

// Zap out through Jupiter aggregator
const zapOutJupiterTx = await zap.zapOutThroughJupiter({
  user: wallet.publicKey,
  inputMint: tokenMint,
  outputMint: SOL_MINT,
  jupiterSwapResponse: jupiterQuote,
  maxSwapAmount: new BN(1_000_000_000),
  percentageToZap: 100,
});
```

### Helper Functions

```typescript
// Get token program from mint
const tokenProgram = await zap.getTokenProgramFromMint(connection, mintAddress);

// Get Jupiter swap instruction
const swapIx = await zap.getJupiterSwapInstruction(jupiterQuote, wallet.publicKey);
```

---

## Pool Farms SDK

The Pool Farms SDK enables creating and managing liquidity mining farms on DAMM v1 pools.

### Basic Setup

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { FarmImpl } from '@meteora-ag/farming';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const farmAddress = new PublicKey('FARM_ADDRESS');

const farm = await FarmImpl.create(connection, farmAddress);
```

### Farm Operations

```typescript
// Deposit LP tokens to farm
const depositTx = await farm.deposit(
  wallet.publicKey,
  lpAmount
);

// Withdraw LP tokens from farm
const withdrawTx = await farm.withdraw(
  wallet.publicKey,
  lpAmount
);

// Claim farming rewards
const claimTx = await farm.claim(wallet.publicKey);

// Get pending rewards
const pendingRewards = await farm.getPendingRewards(wallet.publicKey);
console.log('Pending rewards:', pendingRewards.toString());

// Get user stake info
const stakeInfo = await farm.getUserStakeInfo(wallet.publicKey);
console.log('Staked amount:', stakeInfo.amount.toString());
```

---

## Common Patterns

### Pattern 1: Initialize with Wallet

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet, AnchorProvider } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const keypair = Keypair.fromSecretKey(/* your secret key */);
const wallet = new Wallet(keypair);

const provider = new AnchorProvider(connection, wallet, {
  commitment: 'confirmed',
});

// Now use provider.wallet.publicKey for transactions
const dlmm = await DLMM.create(connection, poolAddress);
```

### Pattern 2: Error Handling

```typescript
try {
  const swapTx = await dlmm.swap(swapParams);
  const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet]);
  console.log('Success:', txHash);
} catch (error) {
  if (error.message.includes('Slippage')) {
    console.error('Slippage exceeded - try increasing tolerance');
  } else if (error.message.includes('InsufficientFunds')) {
    console.error('Not enough balance for this trade');
  } else if (error.message.includes('PoolNotFound')) {
    console.error('Pool does not exist');
  } else {
    throw error;
  }
}
```

### Pattern 3: Batch Operations

```typescript
import { Transaction } from '@solana/web3.js';

// Combine multiple instructions in one transaction
const transaction = new Transaction();

const claimFeeIx = await dlmm.claimSwapFee({ owner: wallet.publicKey, position: pos1 });
const claimRewardIx = await dlmm.claimLMReward({ owner: wallet.publicKey, position: pos1 });

transaction.add(...claimFeeIx.instructions);
transaction.add(...claimRewardIx.instructions);

const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet]);
```

### Pattern 4: Monitor Pool State

```typescript
// Periodically refresh pool state
async function monitorPool(dlmm: DLMM, interval: number = 5000) {
  setInterval(async () => {
    await dlmm.refetchStates();
    const activeBin = await dlmm.getActiveBin();
    console.log(`Current price: ${activeBin.price}`);

    const feeInfo = dlmm.getFeeInfo();
    console.log(`Current fee rate: ${feeInfo.baseFeeRate}%`);
  }, interval);
}
```

---

## New Features (2025-2026)

### DLMM Limit Orders

DLMM now supports fee-free on-chain limit orders:

```typescript
// Place limit order on DLMM
const limitOrderTx = await dlmm.placeLimitOrder({
  user: wallet.publicKey,
  binId: targetBinId,
  amount: new BN(1_000_000),
  side: "buy", // or "sell"
});
```

### Auto Vaults (Coming Q1 2026)

Auto vaults automatically compound fees and support custom market-making strategies through APIs. These vaults help users earn more with less effort.

### Universal Curve (DBC)

The Dynamic Bonding Curve now supports programmable 16-point curves, giving LPs precise control over price trajectories:

```typescript
// Create pool with custom curve
const createPoolTx = await dbc.createPoolWithCurve({
  creator: wallet.publicKey,
  baseMint,
  quoteMint,
  curvePoints: [
    { price: 0.001, supply: 0 },
    { price: 0.01, supply: 100_000_000 },
    { price: 0.1, supply: 500_000_000 },
    // ... up to 16 points
  ],
});
```

### Presale Vault *(Beta)*

Presale Vault is Meteora's token presale infrastructure, currently in beta. It enables projects to run presales with built-in protection mechanisms.

> **Note:** Presale Vault is in active development. Check the [Meteora documentation](https://docs.meteora.ag) for the latest information.

---

## GitHub Repositories

### TypeScript SDKs

| Repository | Description | Stars |
|------------|-------------|-------|
| [dlmm-sdk](https://github.com/MeteoraAg/dlmm-sdk) | DLMM concentrated liquidity SDK | 280+ |
| [damm-v2-sdk](https://github.com/MeteoraAg/cp-amm-sdk) | DAMM v2 constant product AMM SDK | 44+ |
| [damm-v1-sdk](https://github.com/MeteoraAg/damm-v1-sdk) | Legacy DAMM v1 SDK | 126+ |
| [dynamic-bonding-curve-sdk](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk) | Token launch bonding curves | 35+ |
| [zap-sdk](https://github.com/MeteoraAg/zap-sdk) | Single-token entry/exit | 2+ |
| [vault-sdk](https://github.com/MeteoraAg/vault-sdk) | Dynamic vault SDK | - |
| [alpha-vault-sdk](https://github.com/MeteoraAg/alpha-vault-sdk) | Anti-bot launch protection | - |
| [m3m3](https://github.com/MeteoraAg/stake-for-fee-sdk) | Stake-for-fee SDK | - |

### Go SDKs

| Repository | Description |
|------------|-------------|
| [damm-v2-go](https://github.com/MeteoraAg/damm-v2-go) | DAMM v2 Go implementation |
| [dbc-go](https://github.com/MeteoraAg/dbc-go) | Dynamic Bonding Curve Go SDK |

### Core Programs (Rust)

| Repository | Description | Stars |
|------------|-------------|-------|
| [damm-v2](https://github.com/MeteoraAg/damm-v2) | DAMM v2 program | 98+ |
| [dynamic-bonding-curve](https://github.com/MeteoraAg/dynamic-bonding-curve) | DBC program | 86+ |
| [zap-program](https://github.com/MeteoraAg/zap-program) | Zap on-chain program | - |

---

## Meteora Invent (CLI Tool)

**Metsumi** is Meteora's CLI tool for launching tokens and executing on-chain actions with minimal configuration.

### Installation

```bash
# Prerequisites: Node.js ≥ 18.0.0, pnpm ≥ 10.0.0
git clone https://github.com/MeteoraAg/meteora-invent.git
cd meteora-invent
npm install -g pnpm
pnpm install
```

### Available Commands

#### DLMM Operations
```bash
# Create permissionless pool
pnpm dlmm-create-pool

# Seed liquidity
pnpm dlmm-seed-liquidity-lfg
pnpm dlmm-seed-liquidity-single-bin

# Control pool trading
pnpm dlmm-set-pool-status
```

#### DAMM v2 Operations
```bash
# Create pools
pnpm damm-v2-create-balanced-pool
pnpm damm-v2-create-one-sided-pool

# Manage liquidity
pnpm damm-v2-add-liquidity
pnpm damm-v2-remove-liquidity
pnpm damm-v2-split-position

# Claim fees
pnpm damm-v2-claim-position-fee
```

#### Dynamic Bonding Curve Operations
```bash
# Create bonding curve
pnpm dbc-create-config
pnpm dbc-create-pool

# Trade on curve
pnpm dbc-swap

# Graduate to AMM
pnpm dbc-migrate-to-damm-v1
pnpm dbc-migrate-to-damm-v2
```

#### Vault Operations
```bash
# Alpha Vault for anti-bot launches
pnpm alpha-vault-create

# Presale Vault (beta)
pnpm presale-vault-create
```

### Configuration Files

Configurations are stored in `studio/config/`:
- `dlmm_config.jsonc` - DLMM pool settings
- `damm_v1_config.jsonc` - DAMM v1 settings
- `damm_v2_config.jsonc` - DAMM v2 settings
- `dbc_config.jsonc` - Bonding curve settings
- `alpha_vault_config.jsonc` - Alpha vault settings

---

## Resources

- [Meteora Documentation](https://docs.meteora.ag)
- [Meteora App](https://app.meteora.ag)
- [GitHub Organization](https://github.com/MeteoraAg)
- [Meteora Discord](https://discord.gg/meteora)
- [Manual Migrator Tool](https://migrator.meteora.ag)

---

## Skill Structure

```
meteora/
├── SKILL.md                          # This file
├── resources/
│   ├── dlmm-api-reference.md         # DLMM SDK complete API
│   ├── damm-v2-api-reference.md      # DAMM v2 SDK complete API
│   ├── damm-v1-api-reference.md      # DAMM v1 SDK complete API
│   ├── zap-api-reference.md          # Zap SDK API reference
│   ├── pool-farms-reference.md       # Pool Farms SDK reference
│   ├── bonding-curve-reference.md    # DBC SDK reference
│   ├── vault-api-reference.md        # Vault SDK reference
│   ├── alpha-vault-reference.md      # Alpha Vault SDK reference
│   ├── m3m3-api-reference.md         # Stake-for-Fee SDK reference
│   ├── github-repos.md               # All GitHub repositories
│   └── program-addresses.md          # All program addresses
├── examples/
│   ├── dlmm/
│   │   ├── swap.ts                   # Basic swap example
│   │   ├── add-liquidity.ts          # Adding liquidity
│   │   └── claim-fees.ts             # Claiming fees/rewards
│   ├── damm-v2/
│   │   ├── create-pool.ts            # Pool creation
│   │   ├── swap.ts                   # Swapping tokens
│   │   └── manage-position.ts        # Position management
│   ├── damm-v1/
│   │   └── basic-operations.ts       # DAMM v1 pool operations
│   ├── zap/
│   │   └── zap-operations.ts         # Zap in/out examples
│   ├── bonding-curve/
│   │   ├── create-token.ts           # Launch token on curve
│   │   ├── trade.ts                  # Buy/sell on curve
│   │   └── graduation.ts             # Pool graduation
│   ├── vault/
│   │   └── deposit-withdraw.ts       # Vault operations
│   ├── alpha-vault/
│   │   └── participation.ts          # Alpha vault participation
│   └── stake-for-fee/
│       └── staking.ts                # Staking operations
├── templates/
│   ├── trading-bot.ts                # Market making template
│   ├── token-launch.ts               # Token launch template
│   └── liquidity-manager.ts          # LP management template
└── docs/
    ├── fee-structures.md             # Fee configuration guide
    ├── migration-guide.md            # DBC to DAMM migration
    ├── strategy-guide.md             # Liquidity strategies
    └── troubleshooting.md            # Common issues
```
