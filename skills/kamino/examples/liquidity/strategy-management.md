# Kamino Liquidity: Strategy Management Examples

Complete examples for managing automated liquidity strategies on Kamino.

## Setup

```typescript
import { Kamino } from "@kamino-finance/kliquidity-sdk";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import Decimal from "decimal.js";
import * as fs from "fs";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const wallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(fs.readFileSync("./keypair.json", "utf-8")))
);

const connection = new Connection(RPC_URL, "confirmed");
const kamino = new Kamino("mainnet-beta", connection);
```

## Explore Strategies

### Get All Strategies

```typescript
async function getAllStrategies(): Promise<void> {
  console.log("Fetching all Kamino strategies...\n");

  const strategies = await kamino.getStrategiesWithAddresses();

  console.log(`Found ${strategies.length} strategies\n`);

  for (const { address, strategy } of strategies.slice(0, 10)) {
    const sharePrice = await kamino.getStrategySharePrice(address);
    const range = await kamino.getStrategyRange(address);

    console.log("────────────────────────────────");
    console.log("Address:", address.toString());
    console.log("Token A:", strategy.tokenAMint.toString());
    console.log("Token B:", strategy.tokenBMint.toString());
    console.log("Share Price:", sharePrice.toFixed(6));
    console.log("Current Price:", range.currentPrice.toFixed(6));
    console.log("Price Range:", range.lowerPrice.toFixed(6), "-", range.upperPrice.toFixed(6));
    console.log("In Range:", range.isInRange);
  }
}
```

### Filter Strategies

```typescript
async function getFilteredStrategies(): Promise<void> {
  // Get only LIVE non-pegged strategies
  const strategies = await kamino.getAllStrategiesWithFilters({
    strategyType: "NON_PEGGED",
    status: "LIVE",
  });

  console.log(`Found ${strategies.length} live non-pegged strategies\n`);

  // Get SOL-based strategies
  const solMint = new PublicKey("So11111111111111111111111111111111111111112");

  const solStrategies = await kamino.getAllStrategiesWithFilters({
    status: "LIVE",
    tokenA: solMint,
  });

  console.log(`Found ${solStrategies.length} SOL strategies`);

  // Get Orca strategies
  const orcaStrategies = await kamino.getAllStrategiesWithFilters({
    status: "LIVE",
    dex: "ORCA",
  });

  console.log(`Found ${orcaStrategies.length} Orca strategies`);
}
```

### Get Strategy Details

```typescript
async function getStrategyDetails(strategyAddress: PublicKey): Promise<void> {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);

  if (!strategy) {
    console.log("Strategy not found");
    return;
  }

  console.log("\n=== Strategy Details ===");
  console.log("Address:", strategyAddress.toString());
  console.log("\nTokens:");
  console.log("  Token A Mint:", strategy.tokenAMint.toString());
  console.log("  Token B Mint:", strategy.tokenBMint.toString());
  console.log("  Token A Decimals:", strategy.tokenAMintDecimals);
  console.log("  Token B Decimals:", strategy.tokenBMintDecimals);

  console.log("\nPosition:");
  console.log("  Tick Lower:", strategy.positionTickLowerIndex);
  console.log("  Tick Upper:", strategy.positionTickUpperIndex);

  console.log("\nVaults:");
  console.log("  Token A Vault:", strategy.tokenAVault.toString());
  console.log("  Token B Vault:", strategy.tokenBVault.toString());

  console.log("\nShares:");
  console.log("  Shares Mint:", strategy.sharesMint.toString());

  // Get share data
  const shareData = await kamino.getStrategyShareData(strategyAddress);
  console.log("\nShare Data:");
  console.log("  Total Shares:", shareData.totalShares.toString());
  console.log("  Share Price:", shareData.sharePrice.toFixed(6));
  console.log("  Token A per Share:", shareData.tokenAPerShare.toFixed(6));
  console.log("  Token B per Share:", shareData.tokenBPerShare.toFixed(6));

  // Get price range
  const range = await kamino.getStrategyRange(strategyAddress);
  console.log("\nPrice Range:");
  console.log("  Current Price:", range.currentPrice.toFixed(6));
  console.log("  Lower Price:", range.lowerPrice.toFixed(6));
  console.log("  Upper Price:", range.upperPrice.toFixed(6));
  console.log("  In Range:", range.isInRange);
  console.log("  Range Width:", range.rangeWidth.mul(100).toFixed(2), "%");
}
```

## Deposit Operations

### Dual Token Deposit

```typescript
async function depositToStrategy(
  strategyAddress: PublicKey,
  tokenAAmount: Decimal,
  tokenBAmount: Decimal,
  slippageBps: number = 50  // 0.5%
): Promise<string> {
  console.log("\n=== Depositing to Strategy ===");
  console.log("Strategy:", strategyAddress.toString());
  console.log("Token A Amount:", tokenAAmount.toString());
  console.log("Token B Amount:", tokenBAmount.toString());
  console.log("Slippage:", slippageBps, "bps");

  const strategy = await kamino.getStrategyByAddress(strategyAddress);
  if (!strategy) throw new Error("Strategy not found");

  const slippage = new Decimal(slippageBps).div(10000);

  // Check token account existence
  const tokenAAta = await kamino.getAssociatedTokenAddressAndData(
    strategy.tokenAMint,
    wallet.publicKey
  );
  const tokenBAta = await kamino.getAssociatedTokenAddressAndData(
    strategy.tokenBMint,
    wallet.publicKey
  );

  console.log("\nToken Accounts:");
  console.log("  Token A ATA exists:", tokenAAta.exists);
  console.log("  Token B ATA exists:", tokenBAta.exists);

  // Build deposit instructions
  const depositIxs = await kamino.deposit(
    strategyAddress,
    wallet.publicKey,
    tokenAAmount,
    tokenBAmount,
    slippage
  );

  console.log("Deposit instructions:", depositIxs.length);

  // Create transaction with extra compute
  const tx = kamino.createTransactionWithExtraBudget(400000);
  tx.add(...depositIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  // Send transaction
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("\nDeposit successful!");
  console.log("Signature:", signature);

  // Check new share balance
  const kTokenAta = await kamino.getAssociatedTokenAddressAndData(
    strategy.sharesMint,
    wallet.publicKey
  );

  if (kTokenAta.exists) {
    const balance = await kamino.getTokenAccountBalance(kTokenAta.address);
    console.log("New kToken balance:", balance.toString());
  }

  return signature;
}
```

### Single Token Deposit

```typescript
async function singleTokenDeposit(
  strategyAddress: PublicKey,
  tokenAmount: Decimal,
  isTokenA: boolean,
  slippageBps: number = 100  // 1% for single-sided
): Promise<string> {
  console.log("\n=== Single Token Deposit ===");
  console.log("Strategy:", strategyAddress.toString());
  console.log("Amount:", tokenAmount.toString());
  console.log("Token:", isTokenA ? "A" : "B");

  const slippage = new Decimal(slippageBps).div(10000);

  const depositIxs = await kamino.singleTokenDeposit(
    strategyAddress,
    wallet.publicKey,
    tokenAmount,
    isTokenA,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget(600000);  // Higher for swap
  tx.add(...depositIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("\nSingle token deposit successful!");
  console.log("Signature:", signature);

  return signature;
}
```

## Withdrawal Operations

### Partial Withdrawal

```typescript
async function withdrawFromStrategy(
  strategyAddress: PublicKey,
  sharesToWithdraw: Decimal,
  slippageBps: number = 50
): Promise<string> {
  console.log("\n=== Withdrawing from Strategy ===");
  console.log("Strategy:", strategyAddress.toString());
  console.log("Shares to withdraw:", sharesToWithdraw.toString());

  const strategy = await kamino.getStrategyByAddress(strategyAddress);
  if (!strategy) throw new Error("Strategy not found");

  // Check current share balance
  const kTokenAta = await kamino.getAssociatedTokenAddressAndData(
    strategy.sharesMint,
    wallet.publicKey
  );

  if (!kTokenAta.exists) {
    throw new Error("No shares found in wallet");
  }

  const currentBalance = await kamino.getTokenAccountBalance(kTokenAta.address);
  console.log("Current share balance:", currentBalance.toString());

  if (sharesToWithdraw.gt(currentBalance)) {
    throw new Error("Insufficient shares");
  }

  const slippage = new Decimal(slippageBps).div(10000);

  const withdrawIxs = await kamino.withdraw(
    strategyAddress,
    wallet.publicKey,
    sharesToWithdraw,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget(400000);
  tx.add(...withdrawIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("\nWithdrawal successful!");
  console.log("Signature:", signature);

  return signature;
}
```

### Withdraw All Shares

```typescript
async function withdrawAll(
  strategyAddress: PublicKey,
  slippageBps: number = 50
): Promise<string> {
  console.log("\n=== Withdrawing All Shares ===");
  console.log("Strategy:", strategyAddress.toString());

  const slippage = new Decimal(slippageBps).div(10000);

  const withdrawIxs = await kamino.withdrawAllShares(
    strategyAddress,
    wallet.publicKey,
    slippage
  );

  const tx = kamino.createTransactionWithExtraBudget(400000);
  tx.add(...withdrawIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("\nFull withdrawal successful!");
  console.log("Signature:", signature);

  return signature;
}
```

## Collect Fees & Rewards

```typescript
async function collectFeesAndRewards(strategyAddress: PublicKey): Promise<string> {
  console.log("\n=== Collecting Fees & Rewards ===");
  console.log("Strategy:", strategyAddress.toString());

  const collectIxs = await kamino.collectFeesAndRewards(
    strategyAddress,
    wallet.publicKey
  );

  const tx = kamino.createTransactionWithExtraBudget(300000);
  tx.add(...collectIxs);

  await kamino.assignBlockInfoToTransaction(tx);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("\nFees collected!");
  console.log("Signature:", signature);

  return signature;
}
```

## Check User Positions

```typescript
async function getUserPositions(): Promise<void> {
  console.log("\n=== Your Kamino Positions ===\n");

  const strategies = await kamino.getStrategiesWithAddresses();

  let totalValueUsd = new Decimal(0);

  for (const { address, strategy } of strategies) {
    // Check if user has shares
    const kTokenAta = await kamino.getAssociatedTokenAddressAndData(
      strategy.sharesMint,
      wallet.publicKey
    );

    if (!kTokenAta.exists) continue;

    const balance = await kamino.getTokenAccountBalanceOrZero(kTokenAta.address);

    if (balance.lte(0)) continue;

    // Get share data
    const shareData = await kamino.getStrategyShareData(address);
    const positionValue = balance.mul(shareData.sharePrice);

    console.log("────────────────────────────────");
    console.log("Strategy:", address.toString());
    console.log("Shares:", balance.toFixed(6));
    console.log("Share Price:", shareData.sharePrice.toFixed(6));
    console.log("Position Value:", positionValue.toFixed(2), "USD");
    console.log("Token A Amount:", balance.mul(shareData.tokenAPerShare).toFixed(6));
    console.log("Token B Amount:", balance.mul(shareData.tokenBPerShare).toFixed(6));

    totalValueUsd = totalValueUsd.add(positionValue);
  }

  console.log("\n════════════════════════════════");
  console.log("Total Portfolio Value:", totalValueUsd.toFixed(2), "USD");
}
```

## Strategy APY Estimation

```typescript
async function estimateStrategyAPY(strategyAddress: PublicKey): Promise<void> {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);
  if (!strategy) throw new Error("Strategy not found");

  console.log("\n=== Strategy APY Estimation ===");

  // Get fees accumulated
  const feesA = new Decimal(strategy.feesACumulative.toString());
  const feesB = new Decimal(strategy.feesBCumulative.toString());

  console.log("Fees A Cumulative:", feesA.toString());
  console.log("Fees B Cumulative:", feesB.toString());

  // Get share data for TVL
  const shareData = await kamino.getStrategyShareData(strategyAddress);
  const tvl = shareData.totalShares.mul(shareData.sharePrice);

  console.log("TVL:", tvl.toFixed(2), "USD");

  // Get strategy age
  const creationTimestamp = strategy.creationTimestamp.toNumber();
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - creationTimestamp;
  const ageDays = ageSeconds / 86400;

  console.log("Strategy Age:", ageDays.toFixed(1), "days");

  // Check if position is in range
  const range = await kamino.getStrategyRange(strategyAddress);
  console.log("In Range:", range.isInRange);
}
```

## Rebalance Information

```typescript
async function getRebalanceInfo(strategyAddress: PublicKey): Promise<void> {
  const strategy = await kamino.getStrategyByAddress(strategyAddress);
  if (!strategy) throw new Error("Strategy not found");

  console.log("\n=== Rebalance Information ===");

  // Get rebalance method
  const rebalanceType = kamino.getRebalanceTypeFromRebalanceFields(
    strategy.rebalanceRaw
  );

  console.log("Rebalance Type:", rebalanceType);

  // Read specific rebalance params based on type
  try {
    const driftParams = await kamino.readDriftRebalanceParams(strategyAddress);
    console.log("\nDrift Parameters:");
    console.log("  Start Mid Tick:", driftParams.startMidTick);
    console.log("  Tick Range:", driftParams.tickRange);
  } catch {
    // Not a drift strategy
  }

  try {
    const periodicParams = await kamino.readPeriodicRebalanceParams(strategyAddress);
    console.log("\nPeriodic Parameters:");
    console.log("  Period:", periodicParams.period);
    console.log("  Last Rebalance:", periodicParams.lastRebalance);
  } catch {
    // Not a periodic strategy
  }

  try {
    const priceParams = await kamino.readPricePercentageParams(strategyAddress);
    console.log("\nPrice Percentage Parameters:");
    console.log("  Reset Range:", priceParams.resetRange);
  } catch {
    // Not a price percentage strategy
  }
}
```

## Full Example: Strategy Lifecycle

```typescript
async function strategyLifecycleExample(): Promise<void> {
  // Step 1: Find a strategy
  const strategies = await kamino.getAllStrategiesWithFilters({
    status: "LIVE",
    strategyType: "NON_PEGGED",
  });

  if (strategies.length === 0) {
    console.log("No strategies found");
    return;
  }

  const { address } = strategies[0];

  // Step 2: Get strategy details
  await getStrategyDetails(address);

  // Step 3: Check current positions
  await getUserPositions();

  // Step 4: Deposit (commented for safety)
  // await depositToStrategy(address, new Decimal(0.1), new Decimal(10), 50);

  // Step 5: Check positions after deposit
  // await getUserPositions();

  // Step 6: Collect fees
  // await collectFeesAndRewards(address);

  // Step 7: Withdraw
  // await withdrawAll(address, 100);
}

strategyLifecycleExample();
```
