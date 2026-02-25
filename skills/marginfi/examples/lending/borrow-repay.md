# Marginfi: Borrow & Repay Examples

Complete examples for borrowing and repaying on Marginfi.

## Setup

```typescript
import {
  MarginfiClient,
  MarginfiAccount,
  MarginRequirementType,
} from "@mrgnlabs/marginfi-client-v2";
import {
  Connection,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import Decimal from "decimal.js";
import * as fs from "fs";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const GROUP_ADDRESS = new PublicKey("4UpD2fh7xH3GwwNQDquQ2ihYQNPobGYtale2D2Kqfounded");
const wallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(fs.readFileSync("./keypair.json", "utf-8")))
);
const connection = new Connection(RPC_URL, "confirmed");
```

## Check Borrowing Capacity

```typescript
async function checkBorrowingCapacity(
  client: MarginfiClient,
  account: MarginfiAccount
): Promise<void> {
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const freeCollateral = new Decimal(account.computeFreeCollateral().toString());

  console.log("=== Borrowing Capacity ===");
  console.log("Net health (maint):", netHealth.toFixed(4));
  console.log("Free collateral:", freeCollateral.toFixed(4));

  if (netHealth.lte(0)) {
    console.warn("⚠️  Account health is critical");
  } else if (freeCollateral.lte(0)) {
    console.warn("⚠️  Account free collateral is low");
  }

  // Show breakdown
  console.log("\n=== Position Breakdown ===");
  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);

  for (const balance of account.balances) {
    const value = balance.amount.mul(balance.price);

    if (balance.isAsset) {
      totalAssets = totalAssets.plus(value);
      console.log(`📦 ${balance.bankLabel}: $${value.toFixed(2)}`);
    } else {
      totalLiabilities = totalLiabilities.plus(value);
      console.log(`💳 ${balance.bankLabel}: $${value.toFixed(2)}`);
    }
  }

  console.log(`\nTotal Assets: $${totalAssets.toFixed(2)}`);
  console.log(`Total Liabilities: $${totalLiabilities.toFixed(2)}`);
  console.log(`Net Position: $${totalAssets.minus(totalLiabilities).toFixed(2)}`);
}
```

## Simple Borrow

```typescript
async function simpleBorrow(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  // Check account health components first
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const freeCollateral = new Decimal(account.computeFreeCollateral().toString());
  console.log(`\nBorrowing ${amountInTokens} ${bankLabel}...`);
  console.log("Net health (maint):", netHealth.toFixed(4));
  console.log("Free collateral:", freeCollateral.toFixed(4));
  const rates = bank.computeInterestRates();
  console.log("Borrow APY:", new Decimal(rates.borrowingRate.toString()).times(100).toFixed(2), "%");

  const signature = await account.borrow(amountInTokens, bank.address);

  console.log("✓ Borrow successful!");
  console.log("Signature:", signature);

  // Show new position
  await account.reload();
  const { assets: newAssets, liabilities: newLiabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const newHealth = new Decimal(newAssets.toString()).minus(new Decimal(newLiabilities.toString()));
  const position = account.getBalance(bankLabel);

  console.log("New debt:", position?.amount.toString() || "0");
  console.log("New net health:", newHealth.toFixed(4));

  return signature;
}
```

### Borrow with Validation

```typescript
async function borrowWithValidation(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const maxBorrow = new Decimal(account.computeMaxBorrowForBank(bank.address).toString());

  // Validate health
  if (netHealth.lte(0)) {
    throw new Error("❌ Cannot borrow: account health is insufficient");
  }

  // Check if borrow amount is reasonable
  if (new Decimal(amountInTokens).gt(maxBorrow)) {
    throw new Error(
      `❌ Borrow amount exceeds available capacity of $${maxBorrow.toFixed(2)}`
    );
  }

  console.log(`\n✓ Pre-validation passed`);
  console.log(`✓ Borrowing ${amountInTokens} ${bankLabel}`);

  const signature = await account.borrow(amountInTokens, bank.address);

  await account.reload();
  return signature;
}
```

## Simple Repay

```typescript
async function simpleRepay(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number | "max"
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const position = account.getBalance(bankLabel);
  if (position?.isAsset) {
    throw new Error(`No debt found for ${bankLabel}`);
  }

  console.log(`\nRepaying ${amountInTokens} ${bankLabel}...`);
  console.log("Current debt:", position?.amount.toString() || "0");

  // Repay amount handling: use repayAll boolean to include accrued interest
  const repayAll = amountInTokens === "max";
  const repayAmountUi = repayAll ? 0 : amountInTokens;

  console.log("Repay amount (UI):", repayAmountUi, "repayAll:", repayAll);

  const signature = await account.repay(repayAmountUi, bank.address, repayAll);

  console.log("✓ Repayment successful!");
  console.log("Signature:", signature);

  await account.reload();
  const newPosition = account.getBalance(bankLabel);
  console.log("Remaining debt:", newPosition?.amount.toString() || "0");

  return signature;
}
```

### Repay Max (Close Position)

```typescript
async function repayMaxAndClose(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const position = account.getBalance(bankLabel);
  if (position?.isAsset) {
    throw new Error(`No debt found for ${bankLabel}`);
  }

  console.log(`\nClosing ${bankLabel} debt position...`);
  console.log("Current debt:", position?.amount.toString() || "0");
  console.log("(including accrued interest)");

  // Use repayAll=true to automatically include accrued interest
  const signature = await account.repay(0, bank.address, true);

  console.log("✓ Debt position closed!");
  console.log("Signature:", signature);

  await account.reload();
  const newPosition = account.getBalance(bankLabel);

  if (!newPosition || newPosition.amount.isZero()) {
    console.log("✓ Position fully repaid");
  } else {
    console.log("Remaining debt:", newPosition.amount.toString());
  }

  return signature;
}
```

## Partial Repay

```typescript
async function partialRepay(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  percentToRepay: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const position = account.getBalance(bankLabel);
  if (position?.isAsset) {
    throw new Error(`No debt found for ${bankLabel}`);
  }

  // Calculate repay amount
  const repayAmount = position.amount.mul(percentToRepay / 100);

  console.log(`\nRepaying ${percentToRepay}% of ${bankLabel} debt...`);
  console.log("Current debt:", position.amount.toString());
  console.log("Repay amount:", repayAmount.toString());

  const signature = await account.repay(repayAmount.toNumber(), bank.address, false);

  console.log("✓ Partial repayment successful!");
  console.log("Signature:", signature);

  await account.reload();
  const newPosition = account.getBalance(bankLabel);
  console.log("Remaining debt:", newPosition?.amount.toString() || "0");

  return signature;
}
```

## Borrow-Repay Cycle

```typescript
async function borrowRepay(
  client: MarginfiClient,
  account: MarginfiAccount
): Promise<void> {
  console.log("=== Borrow-Repay Cycle ===\n");

  // Step 1: Check initial state
  await account.reload();
  let { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  let netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  console.log("Step 1: Initial net health =", netHealth.toFixed(4));

  // Step 2: Borrow USDC
  console.log("\nStep 2: Borrow 100 USDC");
  await simpleBorrow(client, account, "USDC", 100);

  // Step 3: Check health after borrow
  await account.reload();
  ({ assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance));
  netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  console.log("\nStep 3: Net health after borrow =", netHealth.toFixed(4));

  // Wait to accumulate interest
  console.log("Step 4: Waiting to accumulate interest...");
  await new Promise((r) => setTimeout(r, 5000));

  // Step 5: Check debt with interest
  await account.reload();
  const debtPosition = account.getBalance("USDC");
  console.log("\nStep 5: Debt with interest:", debtPosition?.amount.toString());

  // Step 6: Repay with max
  console.log("\nStep 6: Repaying with 'max' (includes interest)");
  await simpleRepay(client, account, "USDC", "max");

  // Step 7: Verify debt is closed
  await account.reload();
  ({ assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance));
  netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const finalDebt = account.getBalance("USDC");
  console.log("\nStep 7: Final debt:", finalDebt?.amount.toString() || "0");
  console.log("Final net health:", netHealth.toFixed(4));
}
```

## Interest Accumulation Example

```typescript
async function demonstrateInterest(
  client: MarginfiClient,
  account: MarginfiAccount
): Promise<void> {
  const bank = client.getBankByTokenSymbol("USDC");
  if (!bank) throw new Error("USDC bank not found");

  console.log("=== Interest Accumulation Demo ===\n");

  // Borrow
  console.log("Step 1: Borrowing 1000 USDC");
  await simpleBorrow(client, account, "USDC", 1000);

  await account.reload();
  let position = account.getBalance("USDC");
  const initialDebt = new Decimal(position?.amount.toString() || "0");
  console.log("Initial debt:", initialDebt.toFixed(2));

  // Wait and observe interest
  const waitTimes = [5000, 10000, 15000];
  for (const waitTime of waitTimes) {
    console.log(`\nWaiting ${waitTime / 1000}s...`);
    await new Promise((r) => setTimeout(r, waitTime));

    await account.reload();
    position = account.getBalance("USDC");
    const currentDebt = new Decimal(position?.amount.toString() || "0");
    const interest = currentDebt.minus(initialDebt);

    console.log(`After ${waitTime / 1000}s:`);
    console.log(`  Debt: ${currentDebt.toFixed(2)}`);
    console.log(`  Interest: ${interest.toFixed(2)}`);
    const rates = bank.computeInterestRates();
    console.log(`  APY: ${new Decimal(rates.borrowingRate.toString()).times(100).toFixed(2)}%`);
  }

  // Repay with interest
  console.log("\nRepaying with 'max' to close position...");
  await repayMaxAndClose(client, account, "USDC");
}
```

## Health-Aware Borrowing

```typescript
async function borrowWithHealthBuffer(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number,
  healthBuffer: number = 0.3 // 30% safety buffer
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const maxBorrow = new Decimal(account.computeMaxBorrowForBank(bank.address).toString());

  console.log("\n=== Health-Aware Borrow ===");
  console.log("Current net health:", netHealth.toFixed(4));
  console.log("Max borrow (bank): $" + maxBorrow.toFixed(2));
  console.log("Health buffer %:", (healthBuffer * 100).toFixed(0) + "%");

  // Check with buffer
  const maxBorrowWithBuffer = maxBorrow.mul(1 - healthBuffer);

  if (new Decimal(amountInTokens).gt(maxBorrowWithBuffer)) {
    throw new Error(
      `❌ Borrow amount too large. Max with buffer: $${maxBorrowWithBuffer.toFixed(2)}`
    );
  }

  console.log("✓ Borrow amount within safe limits");

  const signature = await account.borrow(amountInTokens, bank.address);

  await account.reload();
  const { assets: postAssets, liabilities: postLiabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const postNetHealth = new Decimal(postAssets.toString()).minus(new Decimal(postLiabilities.toString()));
  console.log("Net health after borrow:", postNetHealth.toFixed(4));

  return signature;
}
```

## Complete Borrow Workflow

```typescript
async function main() {
  try {
    const { client, account } = await loadClientAndAccount();

    // Initial setup: deposit collateral
    console.log("=== Setup: Deposit Collateral ===");
    await simpleBorrow(client, account, "SOL", 5);

    // Check capacity
    console.log("\n=== Check Borrowing Capacity ===");
    await checkBorrowingCapacity(client, account);

    // Borrow
    console.log("\n=== Borrow ===");
    await borrowWithValidation(client, account, "USDC", 5000);

    // Wait for interest
    console.log("\nWaiting for interest accumulation...");
    await new Promise((r) => setTimeout(r, 10000));

    // Partial repay
    console.log("\n=== Partial Repay ===");
    await partialRepay(client, account, "USDC", 50); // Repay 50%

    // Repay remaining
    console.log("\n=== Repay Remaining ===");
    await repayMaxAndClose(client, account, "USDC");

    // Final state
    console.log("\n=== Final State ===");
    await account.reload();
    await checkBorrowingCapacity(client, account);
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
```
