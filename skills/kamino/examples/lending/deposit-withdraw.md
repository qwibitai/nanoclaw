# Kamino Lending: Deposit & Withdraw Examples

Complete examples for depositing and withdrawing assets from Kamino Lend.

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

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

// Load wallet
const wallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(fs.readFileSync("./keypair.json", "utf-8")))
);

const connection = new Connection(RPC_URL, "confirmed");
```

## Load Market

```typescript
async function loadMarket(): Promise<KaminoMarket> {
  console.log("Loading Kamino market...");

  const market = await KaminoMarket.load(connection, MAIN_MARKET);
  await market.loadReserves();

  console.log("Market loaded with", market.reserves.size, "reserves");

  return market;
}
```

## Get Reserve Information

```typescript
async function getReserveInfo(market: KaminoMarket, symbol: string) {
  const reserve = market.getReserve(symbol);

  if (!reserve) {
    throw new Error(`Reserve ${symbol} not found`);
  }

  console.log(`\n=== ${symbol} Reserve ===`);
  console.log("Total Deposits:", reserve.stats.totalDepositsWads.toString());
  console.log("Total Borrows:", reserve.stats.totalBorrowsWads.toString());
  console.log("Available Liquidity:", reserve.stats.availableLiquidityWads.toString());
  console.log("Supply APY:", (reserve.stats.supplyInterestAPY * 100).toFixed(2), "%");
  console.log("Borrow APY:", (reserve.stats.borrowInterestAPY * 100).toFixed(2), "%");
  console.log("Utilization:", (reserve.stats.utilizationRate * 100).toFixed(2), "%");
  console.log("LTV:", (reserve.stats.loanToValueRatio * 100).toFixed(0), "%");
  console.log("Liquidation Threshold:", (reserve.stats.liquidationThreshold * 100).toFixed(0), "%");

  return reserve;
}
```

## Deposit Example

### Basic Deposit

```typescript
async function deposit(
  market: KaminoMarket,
  tokenSymbol: string,
  amountInTokens: number
): Promise<string> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  // Convert to base units
  const decimals = reserve.stats.decimals;
  const amountBase = new Decimal(amountInTokens)
    .mul(new Decimal(10).pow(decimals))
    .floor()
    .toString();

  console.log(`\nDepositing ${amountInTokens} ${tokenSymbol}...`);
  console.log("Amount in base units:", amountBase);

  // Build deposit transaction
  const kaminoAction = await KaminoAction.buildDepositTxns(
    market,
    amountBase,
    tokenSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    300000,     // Extra compute budget
    true,       // Include ATA init instructions
    undefined,  // No referrer
    undefined,  // Current slot
    "confirmed"
  );

  // Combine all instructions
  const instructions = [
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];

  console.log("Instructions count:", instructions.length);

  // Create and send transaction
  const tx = new Transaction().add(...instructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("Deposit successful!");
  console.log("Signature:", signature);

  return signature;
}
```

### Deposit SOL

```typescript
async function depositSol(amountInSol: number): Promise<string> {
  const market = await loadMarket();
  return deposit(market, "SOL", amountInSol);
}

// Example: Deposit 0.1 SOL
// await depositSol(0.1);
```

### Deposit USDC

```typescript
async function depositUsdc(amountInUsdc: number): Promise<string> {
  const market = await loadMarket();
  return deposit(market, "USDC", amountInUsdc);
}

// Example: Deposit 10 USDC
// await depositUsdc(10);
```

## Withdraw Example

### Basic Withdraw

```typescript
async function withdraw(
  market: KaminoMarket,
  tokenSymbol: string,
  amountInTokens: number | "max"
): Promise<string> {
  const reserve = market.getReserve(tokenSymbol);
  if (!reserve) throw new Error(`Reserve ${tokenSymbol} not found`);

  let withdrawAmount: string;

  if (amountInTokens === "max") {
    withdrawAmount = "max";
    console.log(`\nWithdrawing MAX ${tokenSymbol}...`);
  } else {
    const decimals = reserve.stats.decimals;
    withdrawAmount = new Decimal(amountInTokens)
      .mul(new Decimal(10).pow(decimals))
      .floor()
      .toString();
    console.log(`\nWithdrawing ${amountInTokens} ${tokenSymbol}...`);
    console.log("Amount in base units:", withdrawAmount);
  }

  // Build withdraw transaction
  const kaminoAction = await KaminoAction.buildWithdrawTxns(
    market,
    withdrawAmount,
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

  console.log("Withdraw successful!");
  console.log("Signature:", signature);

  return signature;
}
```

### Withdraw All

```typescript
async function withdrawAll(tokenSymbol: string): Promise<string> {
  const market = await loadMarket();
  return withdraw(market, tokenSymbol, "max");
}

// Example: Withdraw all SOL
// await withdrawAll("SOL");
```

## Check User Position

```typescript
async function checkPosition(market: KaminoMarket): Promise<void> {
  await market.refreshAll();

  const obligation = await market.getUserVanillaObligation(wallet.publicKey);

  if (!obligation) {
    console.log("\nNo active position found.");
    return;
  }

  console.log("\n=== Your Position ===");
  console.log("Obligation address:", obligation.address.toString());

  console.log("\nDeposits:");
  for (const deposit of obligation.deposits) {
    const reserve = market.reserves.get(deposit.depositReserve.toString());
    console.log(`  ${reserve?.stats.symbol}: ${deposit.marketValue.toString()} USD`);
  }

  console.log("\nBorrows:");
  for (const borrow of obligation.borrows) {
    const reserve = market.reserves.get(borrow.borrowReserve.toString());
    console.log(`  ${reserve?.stats.symbol}: ${borrow.marketValue.toString()} USD`);
  }

  const stats = obligation.refreshedStats;
  console.log("\nStats:");
  console.log("  Total Deposited:", stats.depositedValue.toString(), "USD");
  console.log("  Total Borrowed:", stats.borrowedValue.toString(), "USD");
  console.log("  Net Account Value:", stats.netAccountValue.toString(), "USD");
  console.log("  Borrow Limit:", stats.borrowLimit.toString(), "USD");

  // Calculate health factor
  if (stats.borrowedValue.gt(0)) {
    const healthFactor = stats.borrowLimit.div(stats.borrowedValue);
    console.log("  Health Factor:", healthFactor.toFixed(2));

    if (healthFactor.lt(1.1)) {
      console.log("  ⚠️ WARNING: Health factor below 1.1!");
    }
  }
}
```

## Deposit and Borrow in One Transaction

```typescript
async function depositAndBorrow(
  tokenSymbol: string,
  depositAmount: number,
  borrowSymbol: string,
  borrowAmount: number
): Promise<string> {
  const market = await loadMarket();

  const depositReserve = market.getReserve(tokenSymbol);
  const borrowReserve = market.getReserve(borrowSymbol);

  if (!depositReserve) throw new Error(`Deposit reserve ${tokenSymbol} not found`);
  if (!borrowReserve) throw new Error(`Borrow reserve ${borrowSymbol} not found`);

  const depositBase = new Decimal(depositAmount)
    .mul(new Decimal(10).pow(depositReserve.stats.decimals))
    .floor()
    .toString();

  const borrowBase = new Decimal(borrowAmount)
    .mul(new Decimal(10).pow(borrowReserve.stats.decimals))
    .floor()
    .toString();

  console.log(`\nDeposit ${depositAmount} ${tokenSymbol} and borrow ${borrowAmount} ${borrowSymbol}...`);

  const kaminoAction = await KaminoAction.buildDepositAndBorrowTxns(
    market,
    depositBase,
    tokenSymbol,
    borrowBase,
    borrowSymbol,
    wallet.publicKey,
    new VanillaObligation(PROGRAM_ID),
    300000,
    true,
    false,
    undefined,
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

  console.log("Deposit and borrow successful!");
  console.log("Signature:", signature);

  return signature;
}

// Example: Deposit 1 SOL and borrow 50 USDC
// await depositAndBorrow("SOL", 1, "USDC", 50);
```

## Full Example Script

```typescript
async function main() {
  try {
    const market = await loadMarket();

    // Get reserve information
    await getReserveInfo(market, "SOL");
    await getReserveInfo(market, "USDC");

    // Check current position
    await checkPosition(market);

    // Deposit 0.1 SOL
    await deposit(market, "SOL", 0.1);

    // Check position after deposit
    await checkPosition(market);

    // Withdraw 0.05 SOL
    await withdraw(market, "SOL", 0.05);

    // Final position check
    await checkPosition(market);

  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

main();
```

## Error Handling

```typescript
import { KaminoError, ErrorCode } from "@kamino-finance/klend-sdk";

async function safeDeposit(
  market: KaminoMarket,
  tokenSymbol: string,
  amount: number
) {
  try {
    return await deposit(market, tokenSymbol, amount);
  } catch (error) {
    if (error instanceof KaminoError) {
      switch (error.code) {
        case ErrorCode.DepositLimitExceeded:
          console.error("Deposit limit exceeded for this reserve");
          break;
        case ErrorCode.CollateralDisabled:
          console.error("Deposits are disabled for this asset");
          break;
        default:
          console.error("Kamino error:", error.message);
      }
    } else if (error.message?.includes("insufficient funds")) {
      console.error("Insufficient token balance");
    } else {
      throw error;
    }
  }
}
```

## CLI Usage

```bash
# Using the klend-sdk CLI
yarn cli deposit --url $RPC_URL --owner ./keypair.json --token SOL --amount 0.1
yarn cli withdraw --url $RPC_URL --owner ./keypair.json --token SOL --amount 0.05
```
