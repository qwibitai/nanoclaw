---
name: marginfi
description: Complete guide for Marginfi - Solana's decentralized lending protocol for lending, borrowing, leveraged positions(looping) and flash loans. Covers account creation, deposits, borrows, repayments, withdrawals, flash loans, and leveraged positions using the @mrgnlabs/marginfi-client-v2 SDK.
---

# Marginfi Development Guide

Build lending and borrowing applications on Solana with Marginfi - a decentralized, overcollateralized lending protocol offering deposits, borrows, flash loans, and leveraged positions.

## Overview

Marginfi provides:
- **Lending & Borrowing**: Deposit collateral to earn yield, borrow against your deposits
- **Multiple Accounts**: Create multiple accounts per wallet with independent positions
- **Risk Management**: Advanced health calculations using asset and liability weights
- **Flash Loans**: Atomic, uncollateralized lending within a single transaction
- **Looping**: Leverage positions by depositing and borrowing in a single transaction
- **Multi-Asset Support**: SOL, USDC, LSTs (JitoSOL, mSOL), and more

## Quick Start

### Installation

```bash
# Marginfi client SDK
npm install @mrgnlabs/marginfi-client-v2

# Common utilities
npm install @mrgnlabs/mrgn-common

# Required peer dependencies
npm install @solana/web3.js @coral-xyz/anchor
```

### Environment Setup

```bash
# .env file
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_KEYPAIR_PATH=./keypair.json
```

## Marginfi SDK (marginfi-client-v2)

The SDK enables interaction with Marginfi's lending protocol for deposits, borrows, repayments, withdrawals, and advanced operations.

### Core Classes

| Class | Purpose |
|-------|---------|
| `MarginfiClient` | Main client for loading groups and banks |
| `MarginfiAccountWrapper` | User account management and lending operations |
| `Bank` | Individual lending pool configuration and state |
| `Balance` | Asset or liability position within an account |
| `NodeWallet` | Wallet adapter for server-side usage |

### Initialize Client

```typescript
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import { Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const keypair = Keypair.fromSecretKey(/* your secret key */);
const wallet = new NodeWallet(keypair);

// Get production configuration
const config = getConfig("production");

// Load Marginfi client
const client = await MarginfiClient.fetch(config, wallet, connection);

// Access banks
for (const [address, bank] of client.banks) {
  console.log(`${bank.tokenSymbol}: ${address}`);
}
```

### Get Bank by Token

```typescript
// Get bank by token symbol
const solBank = client.getBankByTokenSymbol("SOL");
const usdcBank = client.getBankByTokenSymbol("USDC");

// Get bank by mint address
const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdcBankByMint = client.getBankByMint(usdcMint);

// Get bank by public key
const bank = client.getBankByPk(new PublicKey("..."));
```

### Create Account

```typescript
// Create a new Marginfi account
const account = await client.createMarginfiAccount();

console.log("Account address:", account.address.toBase58());
console.log("Authority:", account.authority.toBase58());
```

### Fetch Existing Accounts

```typescript
// Get all accounts for a wallet
const accounts = await client.getMarginfiAccountsForAuthority(wallet.publicKey);

for (const account of accounts) {
  console.log("Account:", account.address.toBase58());
  console.log("Active balances:", account.activeBalances.length);
  
  // Check positions
  for (const balance of account.activeBalances) {
    const bank = client.getBankByPk(balance.bankPk);
    const quantity = balance.computeQuantityUi(bank!);
    console.log(`  ${bank?.tokenSymbol}: Assets=${quantity.assets}, Liabilities=${quantity.liabilities}`);
  }
}
```

### Deposit Collateral

```typescript
async function deposit(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  tokenSymbol: string,
  amount: number // UI-denominated amount (tokens, e.g., 1 for 1 SOL)
) {
  const bank = client.getBankByTokenSymbol(tokenSymbol);
  if (!bank) throw new Error(`Bank ${tokenSymbol} not found`);

  // Execute deposit
  const signature = await account.deposit(amount, bank.address);
  
  console.log("Deposit signature:", signature);
  return signature;
}

// Example: Deposit 1 SOL
await deposit(account, client, "SOL", 1);
```

### Borrow Assets

```typescript
async function borrow(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  tokenSymbol: string,
  amount: number
) {
  const bank = client.getBankByTokenSymbol(tokenSymbol);
  if (!bank) throw new Error(`Bank ${tokenSymbol} not found`);

  // Execute borrow
    const signature = await account.borrow(amount, bank.address);
  
  console.log("Borrow signature:", signature);
  return signature;
}

// Example: Borrow 100 USDC
await borrow(account, client, "USDC", 100);
```

### Repay Debt

```typescript
async function repay(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  tokenSymbol: string,
  amount: number,
  repayAll: boolean = false
) {
  const bank = client.getBankByTokenSymbol(tokenSymbol);
  if (!bank) throw new Error(`Bank ${tokenSymbol} not found`);

  // Execute repay
  const signature = await account.repay(amount, bank.address, repayAll);
  
  console.log("Repay signature:", signature);
  return signature;
}

// Partial repay
await repay(account, client, "USDC", 50);

// Repay all (handles accrued interest)
await repay(account, client, "USDC", 0, true);
```

### Withdraw Collateral

```typescript
async function withdraw(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  tokenSymbol: string,
  amount: number,
  withdrawAll: boolean = false
) {
  const bank = client.getBankByTokenSymbol(tokenSymbol);
  if (!bank) throw new Error(`Bank ${tokenSymbol} not found`);

  // Execute withdraw
  const signature = await account.withdraw(amount, bank.address, withdrawAll);
  
  console.log("Withdraw signature:", signature);
  return signature;
}

// Partial withdraw
await withdraw(account, client, "SOL", 0.5);

// Withdraw all
await withdraw(account, client, "SOL", 0, true);
```

## Advanced Operations

### Flash Loans

Execute uncollateralized loans that must be repaid within the same transaction:

```typescript
import { TransactionInstruction } from "@solana/web3.js";

async function executeFlashLoan(
  account: MarginfiAccountWrapper,
  customInstructions: TransactionInstruction[]
) {
  // Flash loan allows you to borrow without collateral
  // as long as you repay in the same transaction
  const signature = await account.flashLoan({
    ixs: customInstructions
  });
  
  console.log("Flash loan signature:", signature);
  return signature;
}
```

### Looping (Leverage)

Deposit and borrow in a single transaction for leveraged positions:

```typescript
import { AddressLookupTableAccount, TransactionInstruction } from "@solana/web3.js";

async function loop(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  depositToken: string,
  borrowToken: string,
  depositAmount: number,
  borrowAmount: number,
  swapInstructions: TransactionInstruction[],
  swapLookupTables: AddressLookupTableAccount[]
) {
  const depositBank = client.getBankByTokenSymbol(depositToken);
  const borrowBank = client.getBankByTokenSymbol(borrowToken);
  
  if (!depositBank || !borrowBank) {
    throw new Error("Bank not found");
  }

  const signature = await account.loop(
    depositAmount,
    borrowAmount,
    depositBank.address,
    borrowBank.address,
    swapInstructions,
    swapLookupTables
  );
  
  console.log("Loop signature:", signature);
  return signature;
}
```

### Repay with Collateral

Repay debt using deposited collateral via a swap:

```typescript
async function repayWithCollateral(
  account: MarginfiAccountWrapper,
  client: MarginfiClient,
  repayAmount: number,
  withdrawAmount: number,
  depositToken: string,
  borrowToken: string,
  swapInstructions: TransactionInstruction[],
  swapLookupTables: AddressLookupTableAccount[]
) {
  const depositBank = client.getBankByTokenSymbol(depositToken);
  const borrowBank = client.getBankByTokenSymbol(borrowToken);
  
  if (!depositBank || !borrowBank) {
    throw new Error("Bank not found");
  }

  const signature = await account.repayWithCollateral(
    repayAmount,
    withdrawAmount,
    borrowBank.address,
    depositBank.address,
    swapInstructions,
    swapLookupTables
  );
  
  return signature;
}
```

## Account Health

### Computing Health Components

```typescript
import { MarginRequirementType } from "@mrgnlabs/marginfi-client-v2";

// Get health components
const health = account.computeHealthComponents(MarginRequirementType.Initial);
console.log("Assets:", health.assets.toString());
console.log("Liabilities:", health.liabilities.toString());

// Get free collateral (borrowing capacity)
const freeCollateral = account.computeFreeCollateral();
console.log("Free collateral:", freeCollateral.toString());
```

## Bank Information

### Get Bank Details

```typescript
const bank = client.getBankByTokenSymbol("SOL");
if (bank) {
  console.log("Address:", bank.address.toBase58());
  console.log("Token Symbol:", bank.tokenSymbol);
  console.log("Mint:", bank.mint.toBase58());
  console.log("Decimals:", bank.mintDecimals);
  
  // Compute rates
  const rates = bank.computeInterestRates();
  console.log("Lending Rate:", rates.lendingRate.toString());
  console.log("Borrowing Rate:", rates.borrowingRate.toString());
  
  // Compute totals
  const totalAssets = bank.getTotalAssetQuantity();
  const totalLiabilities = bank.getTotalLiabilityQuantity();
  const utilization = bank.computeUtilizationRate();
  
  console.log("Total Assets:", totalAssets.toString());
  console.log("Total Liabilities:", totalLiabilities.toString());
  console.log("Utilization:", utilization.toString());
}
```

## Building Instructions (Low-Level)

For more control, build instructions separately:

```typescript
// Build deposit instruction without executing
const { instructions, keys } = await account.makeDepositIx(
  1,
  solBank.address
);

// Build borrow instruction
const borrowIx = await account.makeBorrowIx(
  100,
  usdcBank.address
);

// Build repay instruction
const repayIx = await account.makeRepayIx(
  50,
  usdcBank.address
);

// Build withdraw instruction
const withdrawIx = await account.makeWithdrawIx(
  0.5,
  solBank.address
);
```

## Environment Configuration

The SDK supports multiple environments:

```typescript
import { getConfig } from "@mrgnlabs/marginfi-client-v2";

// Production (mainnet)
const prodConfig = getConfig("production");
// Program: MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
// Group: 4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8

// Alpha (mainnet)
const alphaConfig = getConfig("alpha");

// Staging
const stagingConfig = getConfig("staging");

// Development
const devConfig = getConfig("dev");
```

## Constants

SDK exports useful constants:

```typescript
import {
  PDA_BANK_LIQUIDITY_VAULT_AUTH_SEED,
  PDA_BANK_INSURANCE_VAULT_AUTH_SEED,
  PDA_BANK_FEE_VAULT_AUTH_SEED,
  PYTH_PRICE_CONF_INTERVALS,
  SWB_PRICE_CONF_INTERVALS,
  MAX_CONFIDENCE_INTERVAL_RATIO,
  DEFAULT_ORACLE_MAX_AGE,
  USDC_DECIMALS,
  ADDRESS_LOOKUP_TABLE_FOR_GROUP,
} from "@mrgnlabs/marginfi-client-v2";
```

## Resources

| Resource | Link |
|----------|------|
| Official SDK Documentation | [docs.marginfi.com/ts-sdk](https://docs.marginfi.com/ts-sdk) |
| Protocol Documentation | [docs.marginfi.com](https://docs.marginfi.com) |
| GitHub Repository | [github.com/mrgnlabs/mrgn-ts](https://github.com/mrgnlabs/mrgn-ts) |
| SDK Package | [@mrgnlabs/marginfi-client-v2](https://www.npmjs.com/package/@mrgnlabs/marginfi-client-v2) |
| Common utilities | [@mrgnlabs/mrgn-common](https://www.npmjs.com/package/@mrgnlabs/mrgn-common) |
| SDK Configs | [configs.json (repo)](https://github.com/mrgnlabs/mrgn-ts/blob/main/packages/marginfi-client-v2/src/configs.json) |
| SDK Constants | [constants.ts (repo)](https://github.com/mrgnlabs/mrgn-ts/blob/main/packages/marginfi-client-v2/src/constants.ts) |

> Note: The linked `configs.json` and `constants.ts` may not be exhaustive — check the official repository for the latest values and additional constants.

## Related Files

- [marginfi-sdk-api-reference.md](./resources/marginfi-sdk-api-reference.md) - Complete API reference
- [program-addresses.md](./resources/program-addresses.md) - Program and account addresses
- [troubleshooting.md](./docs/troubleshooting.md) - Common issues and solutions
