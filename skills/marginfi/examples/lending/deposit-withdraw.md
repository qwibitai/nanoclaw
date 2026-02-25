# Marginfi: Deposit & Withdraw Examples

Complete examples for depositing and withdrawing assets from Marginfi.

## Setup

```typescript
import {
  MarginfiClient,
  MarginfiAccount,
} from "@mrgnlabs/marginfi-client-v2";
import {
  Connection,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import Decimal from "decimal.js";
import * as fs from "fs";

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const GROUP_ADDRESS = new PublicKey("4UpD2fh7xH3GwwNQDquQ2ihYQNPobGYtale2D2Kqfounded");

// Load wallet
const wallet = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(fs.readFileSync("./keypair.json", "utf-8")))
);

const connection = new Connection(RPC_URL, "confirmed");
```

## Load Client and Account

```typescript
async function loadClientAndAccount() {
  console.log("Loading Marginfi client and account...");

  // Load client
  const client = await MarginfiClient.fetch(GROUP_ADDRESS, wallet, connection);
  console.log("Client loaded with", client.banks.size, "banks");

  // Get user's first account
  const userAccounts = await MarginfiAccount.findAllByOwner(
    connection,
    wallet.publicKey
  );

  if (userAccounts.length === 0) {
    console.log("No accounts found, creating one...");
    const account = await client.createMarginfiAccount();
    console.log("Account created:", account.address.toBase58());

    return { client, account };
  }

  return { client, account: userAccounts[0] };
}
```

## Get Bank Information

```typescript
async function getBankInfo(client: MarginfiClient, bankLabel: string) {
  const bank = client.getBankByTokenSymbol(bankLabel);

  if (!bank) {
    console.log("Available banks:");
    for (const b of client.banks.values()) console.log(`  - ${b.tokenSymbol ?? b.mint.toBase58()}`);
    throw new Error(`Bank ${bankLabel} not found`);
  }

  console.log(`\n=== ${bankLabel} Bank ===`);
  console.log("Bank Address:", bank.address.toBase58());

  // Convert native quantities to UI units using mint decimals
  const totalDepositsUi = new Decimal(bank.getTotalAssetQuantity().toString())
    .div(new Decimal(10).pow(bank.mintDecimals))
    .toFixed(2);
  const totalBorrowsUi = new Decimal(bank.getTotalLiabilityQuantity().toString())
    .div(new Decimal(10).pow(bank.mintDecimals))
    .toFixed(2);

  const availableLiquidityUi = new Decimal(totalDepositsUi).minus(new Decimal(totalBorrowsUi)).toFixed(2);

  const rates = bank.computeInterestRates();
  const depositApy = new Decimal(rates.lendingRate.toString()).times(100).toFixed(2);
  const borrowApy = new Decimal(rates.borrowingRate.toString()).times(100).toFixed(2);
  const utilization = new Decimal(bank.computeUtilizationRate().toString()).times(100).toFixed(2);

  // Initial LTV = 1 / liabilityWeightInit
  const ltvInitial = new Decimal(1).div(new Decimal(bank.config.liabilityWeightInit.toString())).times(100).toFixed(0);

  console.log("Total Deposits:", totalDepositsUi);
  console.log("Total Borrows:", totalBorrowsUi);
  console.log("Available Liquidity:", availableLiquidityUi);
  console.log("Deposit APY:", depositApy, "%");
  console.log("Borrow APY:", borrowApy, "%");
  console.log("Utilization:", utilization, "%");
  console.log("Initial LTV:", ltvInitial, "%");

  return bank;
}
```

## Deposit Example

### Simple Deposit

```typescript
async function simpleDeposit(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  // Display bank info
  console.log(`\nDepositing ${amountInTokens} ${bankLabel}...`);
  const rates = bank.computeInterestRates();
  console.log("Deposit APY:", new Decimal(rates.lendingRate.toString()).times(100).toFixed(2), "%");

  // Convert to base units
  const decimals = bank.mintDecimals;
  const amountBase = new Decimal(amountInTokens).mul(new Decimal(10).pow(decimals)).floor().toString();

  console.log("Amount in base units:", amountBase);

  // High-level SDK accepts UI amounts with bank address
  const signature = await account.deposit(amountInTokens, bank.address);

  console.log("Deposit successful!", signature);

  // Reload account to see updated balance
  await account.reload();
  const balance = account.getBalance(bank.address);
  console.log("New balance:", balance?.amount.toString());

  return signature as string;
}
```

### Deposit with Confirmation

```typescript
async function depositWithConfirmation(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<void> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const decimals = bank.mintDecimals;
  const amountBase = new Decimal(amountInTokens).mul(new Decimal(10).pow(decimals)).floor().toString();

  console.log(`\nDepositing ${amountInTokens} ${bankLabel}...`);
  console.log("Amount (base units):", amountBase);
  console.log("Current balance:", account.getBalance(bank.address)?.amount.toString() || "0");

  // Capture account value before deposit
  const valueBefore = account.computeAccountValue();
  console.log("Account value before:", valueBefore.toString());

  // High-level SDK deposit
  const signature = await account.deposit(amountInTokens, bank.address);

  console.log("✓ Deposit confirmed!", signature);

  // Reload and display new state
  await account.reload();
  const valueAfter = account.computeAccountValue();
  const newBalance = account.getBalance(bank.address);

  console.log("\nAfter deposit:");
  console.log("New balance:", newBalance?.amount.toString());
  console.log("Account value after:", valueAfter.toString());
}
```

## Withdraw Example

### Safe Withdrawal

```typescript
async function safeWithdraw(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const balance = account.getBalance(bank.address);
  if (!balance?.isAsset) {
    throw new Error(`No deposit found for ${bankLabel}`);
  }

  console.log(`\nWithdrawing ${amountInTokens} ${bankLabel}...`);
  console.log("Current balance:", balance.amount.toString());

  // Check if amount exceeds balance
  const decimals = bank.mintDecimals;
  const amountBase = new Decimal(amountInTokens).mul(new Decimal(10).pow(decimals)).floor();

  if (new Decimal(amountBase.toString()).greaterThan(new Decimal(balance.amount.toString()))) {
    throw new Error("Withdrawal amount exceeds balance");
  }

  const signature = await account.withdraw(amountInTokens, bank.address, false);

  console.log("✓ Withdrawal successful!");
  console.log("Signature:", signature);

  // Reload account
  await account.reload();
  const newBalance = account.getBalance(bankLabel);
  console.log("New balance:", newBalance?.amount.toString() || "0");

  return signature;
}
```

### Withdraw All (Close Position)

```typescript
async function withdrawAll(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const balance = account.getBalance(bankLabel);
  if (!balance || !balance.isAsset) {
    throw new Error(`No deposit found for ${bankLabel}`);
  }

  console.log(`\nClosing ${bankLabel} position...`);
  console.log("Current balance:", balance.amount.toString());

  // Withdraw full amount
  const signature = await account.withdraw(0, bank.address, true);

  console.log("✓ Position closed!");
  console.log("Signature:", signature);

  await account.reload();
  const newBalance = account.getBalance(bankLabel);
  console.log("Remaining balance:", newBalance?.amount.toString() || "0");

  return signature;
}
```

## Multi-Asset Portfolio

```typescript
async function depositMultipleAssets(
  client: MarginfiClient,
  account: MarginfiAccount,
  deposits: { bank: string; amount: number }[]
): Promise<string[]> {
  const signatures: string[] = [];

  console.log(`\nDepositing into ${deposits.length} banks...`);

  for (const { bank: bankLabel, amount } of deposits) {
    const bank = client.getBankByTokenSymbol(bankLabel);
    if (!bank) {
      console.warn(`Bank ${bankLabel} not found, skipping`);
      continue;
    }

    console.log(`\n- ${bankLabel}: ${amount} tokens`);

    const sig = await account.deposit(amount, bank.address);

    signatures.push(sig);
    console.log(`  ✓ Deposited`);

    // Small delay between transactions
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Reload to see all balances
  await account.reload();

  console.log("\n=== Portfolio Summary ===");
  let totalValue = new Decimal(0);

  for (const balance of account.balances) {
    if (balance.isAsset) {
      const value = balance.amount.mul(balance.price);
      totalValue = totalValue.plus(value);
      console.log(
        `${balance.bankLabel}: ${balance.amount.toFixed(2)} @ $${balance.price.toFixed(2)}`
      );
    }
  }

  console.log("Total value:", totalValue.toFixed(2));

  return signatures;
}
```

## Partial Withdraw

```typescript
async function partialWithdraw(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  percentToWithdraw: number
): Promise<string> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const balance = account.getBalance(bankLabel);
  if (!balance?.isAsset) {
    throw new Error(`No deposit found for ${bankLabel}`);
  }

  // Calculate withdrawal amount (percentage of current balance)
  const withdrawAmount = balance.amount.mul(percentToWithdraw / 100);

  console.log(`\nWithdrawing ${percentToWithdraw}% of ${bankLabel}...`);
  console.log("Current balance:", balance.amount.toString());
  console.log("Withdrawal amount:", withdrawAmount.toString());

  // Build and send transaction
  const signature = await account.withdraw(withdrawAmount.toNumber(), bank.address, false);

  console.log("✓ Withdrawal successful!");
  console.log("Signature:", signature);

  return signature;
}
```

## Health-Aware Operations

```typescript
async function depositWithAccountValue(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<void> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  // Account value before
  const valueBefore = account.computeAccountValue();

  console.log("\n=== Pre-Deposit Analysis ===");
  console.log("Account value:", valueBefore.toString());
  console.log("Deposit amount:", amountInTokens, bankLabel);

  const signature = await account.deposit(amountInTokens, bank.address);

  console.log("✓ Deposit successful!");
  console.log("Signature:", signature);

  // Show improvement
  await account.reload();
  const valueAfter = account.computeAccountValue();
  console.log("\nAfter deposit:");
  console.log("Account value:", valueAfter.toString());
}

async function withdrawWithAccountValue(
  client: MarginfiClient,
  account: MarginfiAccount,
  bankLabel: string,
  amountInTokens: number
): Promise<void> {
  const bank = client.getBankByTokenSymbol(bankLabel);
  if (!bank) throw new Error(`Bank ${bankLabel} not found`);

  const valueBefore = account.computeAccountValue();

  console.log("\n=== Pre-Withdrawal Analysis ===");
  console.log("Account value:", valueBefore.toString());
  console.log("Withdrawal amount:", amountInTokens, bankLabel);

  const signature = await account.withdraw(amountInTokens, bank.address, false);

  console.log("✓ Withdrawal successful!");
  console.log("Signature:", signature);

  await account.reload();
  const valueAfter = account.computeAccountValue();
  console.log("\nAfter withdrawal:");
  console.log("Account value:", valueAfter.toString());
}
```

## Complete Example

```typescript
async function main() {
  try {
    // Setup
    const { client, account } = await loadClientAndAccount();

    // Step 1: Deposit SOL
    await depositWithConfirmation(client, account, "SOL", 1);

    // Step 2: Deposit USDC
    await depositWithConfirmation(client, account, "USDC", 100);

    // Step 3: Check portfolio
    console.log("\n=== Portfolio ===");
    await account.reload();
    const accountValue = account.computeAccountValue();
    console.log("Account value:", accountValue.toString());

    // Step 4: Withdraw 0.5 SOL
    await safeWithdraw(client, account, "SOL", 0.5);

    // Step 5: Final state
    await account.reload();
    console.log("\n=== Final State ===");
    for (const balance of account.balances) {
      if (balance.isAsset) {
        console.log(`${balance.bankLabel}: ${balance.amount.toString()}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
```
