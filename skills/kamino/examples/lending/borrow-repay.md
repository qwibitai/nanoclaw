# Kamino Lending: Borrow & Repay Examples

Complete examples for borrowing and repaying assets on Kamino Lend.

## Setup

```typescript
import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID
} from "@kamino-finance/klend-sdk";
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
const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

const wallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(fs.readFileSync("./keypair.json", "utf-8")))
);

const connection = new Connection(RPC_URL, "confirmed");
```

## Check Borrow Capacity

```typescript
async function checkBorrowCapacity(market: KaminoMarket): Promise<{
  availableToBorrow: Decimal;
  currentBorrowed: Decimal;
  healthFactor: number;
}> {
  await market.refreshAll();

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);

  if (!obligation) {
    return {
      availableToBorrow: new Decimal(0),
      currentBorrowed: new Decimal(0),
      healthFactor: Infinity,
    };
  }

  const stats = obligation.refreshedStats;

  const availableToBorrow = stats.borrowLimit.sub(stats.borrowedValue);
  const healthFactor = stats.borrowedValue.gt(0)
    ? stats.borrowLimit.div(stats.borrowedValue).toNumber()
    : Infinity;

  console.log("\n=== Borrow Capacity ===");
  console.log("Total Collateral:", stats.depositedValue.toString(), "USD");
  console.log("Borrow Limit:", stats.borrowLimit.toString(), "USD");
  console.log("Current Borrowed:", stats.borrowedValue.toString(), "USD");
  console.log("Available to Borrow:", availableToBorrow.toString(), "USD");
  console.log("Health Factor:", healthFactor.toFixed(2));

  return {
    availableToBorrow,
    currentBorrowed: stats.borrowedValue,
    healthFactor,
  };
}
```

## Borrow Example

### Basic Borrow

```typescript
async function borrow(
  market: KaminoMarket,
  tokenSymbol: string,
  amountInTokens: number
): Promise<string> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  // Check borrow capacity first
  const { availableToBorrow, healthFactor } = await checkBorrowCapacity(market);

  const tokenPrice = reserve.stats.price;
  const borrowValueUsd = new Decimal(amountInTokens).mul(tokenPrice);

  if (borrowValueUsd.gt(availableToBorrow)) {
    throw new Error(
      `Insufficient borrow capacity. Available: ${availableToBorrow.toFixed(2)} USD, ` +
      `Requested: ${borrowValueUsd.toFixed(2)} USD`
    );
  }

  // Convert to base units
  const decimals = reserve.stats.decimals;
  const amountBase = new Decimal(amountInTokens)
    .mul(new Decimal(10).pow(decimals))
    .floor()
    .toString();

  console.log(`\nBorrowing ${amountInTokens} ${tokenSymbol}...`);
  console.log("Amount in base units:", amountBase);
  console.log("Value in USD:", borrowValueUsd.toFixed(2));

  // Build borrow transaction
  const kaminoAction = await KaminoAction.buildBorrowTxns(
    market,
    amountBase,
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    300000,     // Extra compute budget
    true,       // Include ATA init instructions
    false,      // Include deposit for fees
    undefined,  // No referrer
    undefined,  // Current slot
    "confirmed"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  console.log("Instructions count:", instructions.length);

  const tx = new Transaction().add(...instructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("Borrow successful!");
  console.log("Signature:", signature);

  // Check new health factor
  await checkBorrowCapacity(market);

  return signature;
}
```

### Borrow with Safety Check

```typescript
async function safeBorrow(
  market: KaminoMarket,
  tokenSymbol: string,
  amountInTokens: number,
  minHealthFactor: number = 1.5
): Promise<string> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  const { availableToBorrow, currentBorrowed, healthFactor } = await checkBorrowCapacity(market);

  // Calculate new health factor after borrow
  const tokenPrice = reserve.stats.price;
  const borrowValueUsd = new Decimal(amountInTokens).mul(tokenPrice);
  const newBorrowed = currentBorrowed.add(borrowValueUsd);

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);
  if (!obligation) throw new Error("No collateral deposited");

  const borrowLimit = obligation.refreshedStats.borrowLimit;
  const newHealthFactor = borrowLimit.div(newBorrowed).toNumber();

  console.log("\n=== Borrow Simulation ===");
  console.log("Current Health Factor:", healthFactor.toFixed(2));
  console.log("New Health Factor (after borrow):", newHealthFactor.toFixed(2));

  if (newHealthFactor < minHealthFactor) {
    throw new Error(
      `Borrow would result in health factor of ${newHealthFactor.toFixed(2)}, ` +
      `which is below minimum of ${minHealthFactor}`
    );
  }

  return borrow(market, tokenSymbol, amountInTokens);
}
```

### Calculate Max Safe Borrow

```typescript
async function getMaxSafeBorrow(
  market: KaminoMarket,
  tokenSymbol: string,
  targetHealthFactor: number = 1.5
): Promise<Decimal> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  const { availableToBorrow, currentBorrowed } = await checkBorrowCapacity(market);

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);
  if (!obligation) return new Decimal(0);

  const borrowLimit = obligation.refreshedStats.borrowLimit;

  // maxBorrow = borrowLimit / targetHealthFactor - currentBorrowed
  const maxBorrowUsd = borrowLimit.div(targetHealthFactor).sub(currentBorrowed);

  // Convert to token amount
  const tokenPrice = reserve.stats.price;
  const maxBorrowTokens = maxBorrowUsd.div(tokenPrice);

  console.log("\n=== Max Safe Borrow ===");
  console.log("Target Health Factor:", targetHealthFactor);
  console.log("Max borrow (USD):", maxBorrowUsd.toFixed(2));
  console.log("Max borrow (tokens):", maxBorrowTokens.toFixed(6), tokenSymbol);

  return maxBorrowTokens.gt(0) ? maxBorrowTokens : new Decimal(0);
}
```

## Repay Example

### Basic Repay

```typescript
async function repay(
  market: KaminoMarket,
  tokenSymbol: string,
  amountInTokens: number | "max"
): Promise<string> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  let repayAmount: string;

  if (amountInTokens === "max") {
    repayAmount = "max";
    console.log(`\nRepaying MAX ${tokenSymbol}...`);
  } else {
    const decimals = reserve.stats.decimals;
    repayAmount = new Decimal(amountInTokens)
      .mul(new Decimal(10).pow(decimals))
      .floor()
      .toString();
    console.log(`\nRepaying ${amountInTokens} ${tokenSymbol}...`);
    console.log("Amount in base units:", repayAmount);
  }

  // Build repay transaction
  const kaminoAction = await KaminoAction.buildRepayTxns(
    market,
    repayAmount,
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    300000,
    true,
    undefined,
    "confirmed"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("Repay successful!");
  console.log("Signature:", signature);

  // Check new health factor
  await checkBorrowCapacity(market);

  return signature;
}
```

### Repay All Debt

```typescript
async function repayAll(tokenSymbol: string): Promise<string> {
  const market = await KaminoMarket.load(connection, MAIN_MARKET);
  await market.loadReserves();

  return repay(market, tokenSymbol, "max");
}

// Example: Repay all USDC debt
// await repayAll("USDC");
```

### Repay and Withdraw in One Transaction

```typescript
async function repayAndWithdraw(
  repaySymbol: string,
  repayAmount: number | "max",
  withdrawSymbol: string,
  withdrawAmount: number | "max"
): Promise<string> {
  const market = await KaminoMarket.load(connection, MAIN_MARKET);
  await market.loadReserves();

  const repayReserve = market.getReserve(repaySymbol);
  const withdrawReserve = market.getReserve(withdrawSymbol);

  if (!repayReserve) throw new Error(`Repay reserve ${repaySymbol} not found`);
  if (!withdrawReserve) throw new Error(`Withdraw reserve ${withdrawSymbol} not found`);

  const repayBase = repayAmount === "max"
    ? "max"
    : new Decimal(repayAmount)
        .mul(new Decimal(10).pow(repayReserve.stats.decimals))
        .floor()
        .toString();

  const withdrawBase = withdrawAmount === "max"
    ? "max"
    : new Decimal(withdrawAmount)
        .mul(new Decimal(10).pow(withdrawReserve.stats.decimals))
        .floor()
        .toString();

  console.log(`\nRepaying ${repayAmount} ${repaySymbol} and withdrawing ${withdrawAmount} ${withdrawSymbol}...`);

  const kaminoAction = await KaminoAction.buildRepayAndWithdrawTxns(
    market,
    repayBase,
    repaySymbol,
    withdrawBase,
    withdrawSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    300000,
    true,
    undefined,
    "confirmed"
  );

  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  const tx = new Transaction().add(...instructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("Repay and withdraw successful!");
  console.log("Signature:", signature);

  return signature;
}

// Example: Repay all USDC and withdraw all SOL
// await repayAndWithdraw("USDC", "max", "SOL", "max");
```

## Get Borrowed Amounts

```typescript
async function getBorrowedAmounts(market: KaminoMarket): Promise<Map<string, Decimal>> {
  await market.refreshAll();

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);

  const borrowed = new Map<string, Decimal>();

  if (!obligation) {
    return borrowed;
  }

  console.log("\n=== Current Borrows ===");
  for (const borrow of obligation.borrows) {
    const reserve = market.reserves.get(borrow.borrowReserve.toString());
    if (reserve) {
      const symbol = reserve.stats.symbol;
      const amount = borrow.marketValue;
      borrowed.set(symbol, amount);
      console.log(`${symbol}: $${amount.toFixed(2)}`);
    }
  }

  return borrowed;
}
```

## Monitor Health Factor

```typescript
async function monitorHealthFactor(
  market: KaminoMarket,
  intervalMs: number = 60000,
  alertThreshold: number = 1.2
): Promise<void> {
  console.log(`\nMonitoring health factor (alert threshold: ${alertThreshold})...`);

  setInterval(async () => {
    try {
      await market.refreshAll();
      const { healthFactor } = await checkBorrowCapacity(market);

      if (healthFactor < alertThreshold) {
        console.log(`\n⚠️ ALERT: Health factor (${healthFactor.toFixed(2)}) below threshold!`);
        // Here you could add: send notification, auto-repay, etc.
      }
    } catch (error) {
      console.error("Monitor error:", error);
    }
  }, intervalMs);
}
```

## Full Example: Borrow Loop Strategy

```typescript
async function borrowLoopExample(): Promise<void> {
  const market = await KaminoMarket.load(connection, MAIN_MARKET);
  await market.loadReserves();

  // Step 1: Check current position
  await checkBorrowCapacity(market);

  // Step 2: Calculate safe borrow amount
  const maxSafeBorrow = await getMaxSafeBorrow(market, "USDC", 1.5);
  console.log("\nMax safe USDC borrow:", maxSafeBorrow.toFixed(2));

  // Step 3: Borrow 80% of max safe amount
  const borrowAmount = maxSafeBorrow.mul(0.8).toNumber();

  if (borrowAmount > 1) {  // Only borrow if more than 1 USDC
    await safeBorrow(market, "USDC", borrowAmount, 1.4);
  } else {
    console.log("Borrow amount too small, skipping");
  }

  // Step 4: Final position check
  await checkBorrowCapacity(market);
}
```

## Error Handling

```typescript
import { KaminoError, ErrorCode } from "@kamino-finance/klend-sdk";

async function handleBorrowError(
  market: KaminoMarket,
  tokenSymbol: string,
  amount: number
) {
  try {
    return await borrow(market, tokenSymbol, amount);
  } catch (error) {
    if (error instanceof KaminoError) {
      switch (error.code) {
        case ErrorCode.InsufficientCollateral:
          console.error("Not enough collateral. Deposit more assets first.");
          break;
        case ErrorCode.BorrowLimitExceeded:
          console.error("Reserve borrow limit reached. Try a smaller amount.");
          break;
        case ErrorCode.InsufficientLiquidity:
          console.error("Not enough liquidity in the pool.");
          break;
        case ErrorCode.BorrowDisabled:
          console.error("Borrowing is disabled for this asset.");
          break;
        default:
          console.error("Kamino error:", error.message);
      }
    } else {
      throw error;
    }
  }
}
```
