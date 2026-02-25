# Kamino Lending: Leverage/Multiply Examples

Complete examples for leveraged positions using Kamino's Multiply feature.

## Overview

Kamino's Multiply feature allows users to create leveraged long or short positions on assets. The protocol uses flash loans and Jupiter swaps to enable single-transaction leverage operations.

## Setup

```typescript
import {
  KaminoMarket,
  VanillaObligation,
  PROGRAM_ID
} from "@kamino-finance/klend-sdk";
import {
  getLeverageDepositIxns,
  getLeverageWithdrawIxns,
  calculateLeverageMultiplier,
  getMaxLeverage,
  simulateLeveragePosition
} from "@kamino-finance/klend-sdk/leverage";
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
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

## Understanding Leverage

### How Leverage Works

When you open a 3x leveraged long position on SOL with USDC as debt:

1. Deposit 1 SOL as collateral
2. Flash loan additional SOL
3. Swap borrowed USDC to SOL
4. Total exposure: ~3 SOL
5. Debt: USDC loan

```
┌─────────────────────────────────────────┐
│  Deposit: 1 SOL                         │
│  Leverage: 3x                           │
│  ────────────────────────────────────   │
│  Total Collateral: ~3 SOL               │
│  Borrowed: ~200 USDC (at $100/SOL)      │
│  Net Exposure: 3 SOL                    │
│  Liquidation Price: ~$75                │
└─────────────────────────────────────────┘
```

## Check Maximum Leverage

```typescript
async function getMaxLeverageForPair(
  market: KaminoMarket,
  collateralToken: string,
  borrowToken: string
): Promise<number> {
  const maxLeverage = await getMaxLeverage(market, collateralToken, borrowToken);

  console.log(`\n=== Max Leverage: ${collateralToken}/${borrowToken} ===`);
  console.log("Maximum Leverage:", maxLeverage.toFixed(2), "x");

  return maxLeverage;
}
```

## Simulate Leverage Position

```typescript
async function simulatePosition(
  market: KaminoMarket,
  collateralToken: string,
  borrowToken: string,
  depositAmount: Decimal,
  targetLeverage: number
): Promise<void> {
  const simulation = await simulateLeveragePosition(
    market,
    collateralToken,
    borrowToken,
    depositAmount,
    targetLeverage
  );

  console.log(`\n=== Leverage Position Simulation ===`);
  console.log("Deposit:", depositAmount.toString(), collateralToken);
  console.log("Target Leverage:", targetLeverage, "x");
  console.log("────────────────────────────────");
  console.log("Entry Price:", simulation.entryPrice.toString());
  console.log("Liquidation Price:", simulation.liquidationPrice.toString());
  console.log("Health Factor:", simulation.healthFactor.toFixed(2));
  console.log("Effective Leverage:", simulation.effectiveLeverage.toFixed(2), "x");
  console.log("Total Collateral:", simulation.totalCollateral.toString(), collateralToken);
  console.log("Total Borrowed:", simulation.totalBorrowed.toString(), borrowToken);

  // Risk assessment
  const priceDropToLiquidation = simulation.entryPrice
    .sub(simulation.liquidationPrice)
    .div(simulation.entryPrice)
    .mul(100);

  console.log("\nRisk Assessment:");
  console.log("  Price drop to liquidation:", priceDropToLiquidation.toFixed(2), "%");

  if (priceDropToLiquidation.lt(20)) {
    console.log("  ⚠️ HIGH RISK: Liquidation within 20% price drop");
  } else if (priceDropToLiquidation.lt(40)) {
    console.log("  ⚡ MODERATE RISK: Liquidation within 40% price drop");
  } else {
    console.log("  ✅ LOWER RISK: Liquidation requires >40% price drop");
  }
}
```

## Open Leveraged Position

### Long Position (Bullish)

```typescript
async function openLongPosition(
  market: KaminoMarket,
  collateralToken: string,    // Token you're bullish on (e.g., "SOL")
  borrowToken: string,         // Token to borrow (e.g., "USDC")
  depositAmount: Decimal,      // Amount to deposit
  targetLeverage: number       // e.g., 2, 3, 4
): Promise<string> {
  console.log(`\n=== Opening ${targetLeverage}x Long on ${collateralToken} ===`);
  console.log("Deposit:", depositAmount.toString(), collateralToken);
  console.log("Borrow:", borrowToken);

  // Check max leverage
  const maxLeverage = await getMaxLeverage(market, collateralToken, borrowToken);
  if (targetLeverage > maxLeverage) {
    throw new Error(`Target leverage ${targetLeverage}x exceeds max ${maxLeverage.toFixed(2)}x`);
  }

  // Simulate first
  await simulatePosition(market, collateralToken, borrowToken, depositAmount, targetLeverage);

  // Calculate leverage parameters
  const leverageParams = await calculateLeverageMultiplier(
    market,
    collateralToken,
    borrowToken,
    depositAmount,
    targetLeverage
  );

  console.log("\nLeverage Parameters:");
  console.log("  Borrow Amount:", leverageParams.borrowAmount.toString(), borrowToken);
  console.log("  Flash Loan Amount:", leverageParams.flashLoanAmount.toString());
  console.log("  Min Received:", leverageParams.minReceived.toString());

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

  console.log("Instructions count:", instructions.length);
  console.log("Lookup tables:", lookupTables.length);

  // Create versioned transaction
  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  // Send transaction
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(signature, "confirmed");

  console.log("\nLong position opened successfully!");
  console.log("Signature:", signature);

  return signature;
}

// Example: 3x long SOL using USDC as debt
// await openLongPosition(market, "SOL", "USDC", new Decimal(1), 3);
```

### Short Position (Bearish)

```typescript
async function openShortPosition(
  market: KaminoMarket,
  shortToken: string,           // Token you're bearish on (e.g., "SOL")
  collateralToken: string,      // Token to use as collateral (e.g., "USDC")
  depositAmount: Decimal,       // Amount of collateral to deposit
  targetLeverage: number        // e.g., 2, 3
): Promise<string> {
  console.log(`\n=== Opening ${targetLeverage}x Short on ${shortToken} ===`);
  console.log("Collateral:", depositAmount.toString(), collateralToken);
  console.log("Short:", shortToken);

  // For shorts, we deposit stable and borrow the asset we're shorting
  // The borrowed asset is swapped to more stable collateral

  const maxLeverage = await getMaxLeverage(market, collateralToken, shortToken);
  if (targetLeverage > maxLeverage) {
    throw new Error(`Target leverage ${targetLeverage}x exceeds max ${maxLeverage.toFixed(2)}x`);
  }

  // Calculate leverage parameters
  const leverageParams = await calculateLeverageMultiplier(
    market,
    collateralToken,
    shortToken,
    depositAmount,
    targetLeverage
  );

  const { instructions, lookupTables } = await getLeverageDepositIxns(
    market,
    wallet.publicKey,
    collateralToken,
    shortToken,
    depositAmount,
    leverageParams,
    new VanillaObligation(PROGRAM_ID)
  );

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(signature, "confirmed");

  console.log("\nShort position opened successfully!");
  console.log("Signature:", signature);

  return signature;
}

// Example: 2x short SOL with USDC collateral
// await openShortPosition(market, "SOL", "USDC", new Decimal(100), 2);
```

## Close Leveraged Position

### Full Close

```typescript
async function closePosition(
  market: KaminoMarket,
  collateralToken: string,
  borrowToken: string
): Promise<string> {
  console.log(`\n=== Closing Leveraged Position ===`);
  console.log("Collateral:", collateralToken);
  console.log("Debt:", borrowToken);

  // Build close (leverage withdraw) instructions
  const { instructions, lookupTables } = await getLeverageWithdrawIxns(
    market,
    wallet.publicKey,
    collateralToken,
    borrowToken,
    "max",  // Withdraw everything
    new VanillaObligation(PROGRAM_ID)
  );

  console.log("Instructions count:", instructions.length);

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(signature, "confirmed");

  console.log("\nPosition closed successfully!");
  console.log("Signature:", signature);

  return signature;
}
```

### Partial Close (Reduce Leverage)

```typescript
async function reduceLeverage(
  market: KaminoMarket,
  collateralToken: string,
  borrowToken: string,
  withdrawAmount: Decimal    // Amount of collateral to withdraw
): Promise<string> {
  console.log(`\n=== Reducing Leverage ===`);
  console.log("Withdrawing:", withdrawAmount.toString(), collateralToken);

  const { instructions, lookupTables } = await getLeverageWithdrawIxns(
    market,
    wallet.publicKey,
    collateralToken,
    borrowToken,
    withdrawAmount,
    new VanillaObligation(PROGRAM_ID)
  );

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(signature, "confirmed");

  console.log("Leverage reduced!");
  console.log("Signature:", signature);

  return signature;
}
```

## Monitor Leveraged Position

```typescript
async function monitorLeveragedPosition(
  market: KaminoMarket
): Promise<void> {
  await market.refreshAll();

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);
  if (!obligation) {
    console.log("No active position");
    return;
  }

  const stats = obligation.refreshedStats;

  console.log("\n=== Leveraged Position Status ===");

  // Calculate current leverage
  const totalCollateralValue = stats.depositedValue;
  const totalDebtValue = stats.borrowedValue;
  const netValue = totalCollateralValue.sub(totalDebtValue);

  const currentLeverage = netValue.gt(0)
    ? totalCollateralValue.div(netValue).toNumber()
    : 0;

  console.log("Total Collateral:", totalCollateralValue.toFixed(2), "USD");
  console.log("Total Debt:", totalDebtValue.toFixed(2), "USD");
  console.log("Net Value:", netValue.toFixed(2), "USD");
  console.log("Current Leverage:", currentLeverage.toFixed(2), "x");

  // Health factor
  const healthFactor = totalDebtValue.gt(0)
    ? stats.borrowLimit.div(totalDebtValue).toNumber()
    : Infinity;

  console.log("Health Factor:", healthFactor.toFixed(2));

  // Liquidation threshold
  if (healthFactor < 1.1) {
    console.log("⚠️ CRITICAL: Position at risk of liquidation!");
  } else if (healthFactor < 1.3) {
    console.log("⚡ WARNING: Health factor getting low");
  } else {
    console.log("✅ Position healthy");
  }

  // Display collateral breakdown
  console.log("\nCollateral:");
  for (const deposit of obligation.deposits) {
    const reserve = market.reserves.get(deposit.depositReserve.toString());
    console.log(`  ${reserve?.stats.symbol}: $${deposit.marketValue.toFixed(2)}`);
  }

  console.log("\nDebts:");
  for (const borrow of obligation.borrows) {
    const reserve = market.reserves.get(borrow.borrowReserve.toString());
    console.log(`  ${reserve?.stats.symbol}: $${borrow.marketValue.toFixed(2)}`);
  }
}
```

## Calculate P&L

```typescript
interface LeveragePositionPnL {
  entryValue: Decimal;
  currentValue: Decimal;
  pnlUsd: Decimal;
  pnlPercent: number;
  effectiveReturn: number;  // Including leverage
}

async function calculatePnL(
  market: KaminoMarket,
  entryCollateralValue: Decimal,  // USD value when position opened
  entryLeverage: number
): Promise<LeveragePositionPnL> {
  await market.refreshAll();

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);
  if (!obligation) throw new Error("No active position");

  const stats = obligation.refreshedStats;

  const currentValue = stats.depositedValue.sub(stats.borrowedValue);
  const pnlUsd = currentValue.sub(entryCollateralValue);
  const pnlPercent = pnlUsd.div(entryCollateralValue).mul(100).toNumber();

  // Effective return (what you'd have made with leverage)
  const effectiveReturn = pnlPercent * entryLeverage;

  console.log("\n=== Position P&L ===");
  console.log("Entry Value:", entryCollateralValue.toFixed(2), "USD");
  console.log("Current Value:", currentValue.toFixed(2), "USD");
  console.log("P&L (USD):", pnlUsd.toFixed(2));
  console.log("P&L (%):", pnlPercent.toFixed(2), "%");
  console.log("Effective Return:", effectiveReturn.toFixed(2), "%");

  return {
    entryValue: entryCollateralValue,
    currentValue,
    pnlUsd,
    pnlPercent,
    effectiveReturn,
  };
}
```

## Full Example: Leverage Trading Session

```typescript
async function leverageTradingExample(): Promise<void> {
  const market = await KaminoMarket.load(connection, MAIN_MARKET);
  await market.loadReserves();

  console.log("=== Leverage Trading Session ===\n");

  // Step 1: Check max leverage
  await getMaxLeverageForPair(market, "SOL", "USDC");

  // Step 2: Simulate 2x long position
  const depositAmount = new Decimal(0.5);  // 0.5 SOL
  await simulatePosition(market, "SOL", "USDC", depositAmount, 2);

  // Step 3: Open position (commented for safety)
  // const openSig = await openLongPosition(market, "SOL", "USDC", depositAmount, 2);

  // Step 4: Monitor position
  // await monitorLeveragedPosition(market);

  // Step 5: Calculate P&L (using hypothetical entry)
  // await calculatePnL(market, new Decimal(50), 2);

  // Step 6: Close position
  // const closeSig = await closePosition(market, "SOL", "USDC");
}

leverageTradingExample();
```

## Risk Warnings

1. **Liquidation Risk**: Leveraged positions can be liquidated if health factor drops below 1
2. **Slippage**: Large leverage operations may experience slippage
3. **Flash Loan Dependency**: Leverage relies on flash loans and Jupiter swaps
4. **Market Volatility**: High leverage amplifies both gains and losses
5. **Interest Accrual**: Borrowed assets accrue interest continuously

## Best Practices

1. Always simulate positions before opening
2. Use conservative leverage (2-3x) initially
3. Set up health factor monitoring/alerts
4. Have a plan for position management
5. Understand liquidation mechanics
6. Start with small amounts to test
