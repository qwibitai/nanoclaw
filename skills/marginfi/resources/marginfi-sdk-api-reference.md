# Marginfi SDK (marginfi-client-v2) API Reference

Complete API reference for `@mrgnlabs/marginfi-client-v2`. 

## Installation

```bash
npm install @mrgnlabs/marginfi-client-v2 @mrgnlabs/mrgn-common
# or
yarn add @mrgnlabs/marginfi-client-v2 @mrgnlabs/mrgn-common
```

## Core Classes

### MarginfiClient

Main entry point for interacting with Marginfi protocol.

```typescript
import { MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
```

#### Static Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `fetch` | `config: MarginfiConfig, wallet: Wallet, connection: Connection, opts?: ClientOptions` | `Promise<MarginfiClient>` | Load client with configuration |
| `getConfig` | `env: "production" \| "alpha" \| "staging" \| "dev"` | `MarginfiConfig` | Get environment configuration |

#### Instance Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getBankByTokenSymbol` | `symbol: string` | `Bank \| null` | Get bank by token symbol (e.g., "SOL", "USDC") |
| `getBankByMint` | `mint: PublicKey` | `Bank \| null` | Get bank by token mint address |
| `getBankByPk` | `pk: PublicKey` | `Bank \| null` | Get bank by bank public key |
| `getOraclePriceByBank` | `bankAddress: PublicKey` | `OraclePrice \| null` | Get cached oracle price for a bank |
| `getAllMarginfiAccountPubkeys` | `()` | `Promise<PublicKey[]>` | Get addresses of all marginfi accounts in the group |
| `getMultipleMarginfiAccounts` | `pubkeys: PublicKey[]` | `Promise<MarginfiAccountWrapper[]>` | Fetch multiple marginfi accounts by pubkeys |
| `getAllMarginfiAccountAddresses` | `()` | `Promise<PublicKey[]>` | Get all marginfi account addresses for the group |
| `getMarginfiAccountsForAuthority` | `authority?: PublicKey` | `Promise<MarginfiAccountWrapper[]>` | Get all marginfi accounts owned by an authority |
| `getAllProgramAccountAddresses` | `type: AccountType` | `Promise<PublicKey[]>` | Get program account addresses by account type |
| `makeCreateMarginfiAccountIx` | `marginfiAccountPk: PublicKey` | `Promise<InstructionsWrapper>` | Build instruction(s) to initialize a marginfi account |
| `createMarginfiAccount` | `createOpts?: CreateAccountOpts, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<MarginfiAccountWrapper>` | Create a new marginfi account and return the wrapper |
| `createMarginfiAccountTx` | `createOpts?: { accountKeypair?: Keypair }` | `Promise<SolanaTransaction>` | Build a transaction to create a marginfi account |
| `makeCreateMarginfiGroupIx` | `marginfiGroup: PublicKey` | `Promise<InstructionsWrapper>` | Build instruction(s) to initialize a new group |
| `createMarginfiGroup` | `seed?: Keypair, additionalIxs?: TransactionInstruction[], processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<PublicKey>` | Create a new marginfi group and return its address |
| `createPermissionlessBank` | `{ mint: PublicKey; bankConfig: BankConfigOpt; group: PublicKey; admin: PublicKey; seed?: Keypair; processOpts?: ProcessTransactionsClientOpts; txOpts?: TransactionOptions }` | `Promise<TransactionSignature>` | Create a permissionless bank under the group |
| `createLendingPool` | `bankMint: PublicKey, bankConfig: BankConfigOpt, seed?: Keypair, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<{ bankAddress: PublicKey; signature: TransactionSignature }>` | Create a lending pool and return its address and signature |
| `processTransactions` | `transactions: SolanaTransaction[], processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature[]>` | Process multiple transactions (bundle support) |
| `processTransaction` | `transaction: SolanaTransaction, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature>` | Process a single transaction and return its signature |
| `simulateTransactions` | `transactions: (Transaction | VersionedTransaction)[], accountsToInspect: PublicKey[]` | `Promise<(Buffer | null)[]>` | Simulate transactions and return inspected account data |

#### Properties

```typescript
interface MarginfiClient {
  group: MarginfiGroup;
  banks: BankMap;
  oraclePrices: OraclePriceMap;
  mintDatas: MintDataMap;
  addressLookupTables: AddressLookupTableAccount[];
  lookupTablesAddresses: PublicKey[];
  feedIdMap: PythPushFeedIdMap;
  processTransactionStrategy?: ProcessTransactionStrategy;
}
```

### MarginfiAccountWrapper

High-level wrapper for a user's Marginfi account. Only public, non-deprecated members are listed below.

```typescript
import { MarginfiAccountWrapper } from "@mrgnlabs/marginfi-client-v2";
```

#### Static Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `fetch` | `address: PublicKey, client: MarginfiClient, commitment?: Commitment` | `Promise<MarginfiAccountWrapper>` | Load an account from chain and instantiate the wrapper |
| `fromAccountParsed` | `address: PublicKey, client: MarginfiClient, data: MarginfiAccountRaw` | `MarginfiAccountWrapper` | Create wrapper from parsed on-chain data |

#### Instance Methods: Core Operations

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `deposit` | `amount: Amount, bankAddress: PublicKey, depositOpts?: MakeDepositIxOpts, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature>` | Deposit tokens into a bank (returns signature) |
| `withdraw` | `amount: Amount, bankAddress: PublicKey, withdrawAll?: boolean, withdrawOpts?: MakeWithdrawIxOpts, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature[]>` | Withdraw tokens (may include feed-update txs) |
| `borrow` | `amount: Amount, bankAddress: PublicKey, borrowOpts?: MakeBorrowIxOpts, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature[]>` | Borrow tokens from a bank |
| `repay` | `amount: Amount, bankAddress: PublicKey, repayAll?: boolean, repayOpts?: MakeRepayIxOpts, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature>` | Repay a loan |

#### Instance Methods: Advanced Operations

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `flashLoan` | `args: FlashLoanArgs, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature>` | Execute a flash loan (atomic borrow, user instructions, repay) |
| `loopV2` | `props: LoopProps` | `Promise<TransactionSignature[]>` | Perform a leverage loop using flash loans/flash swaps |
| `repayWithCollatV2` | `props: RepayWithCollateralProps` | `Promise<TransactionSignature[]>` | Repay using collateral from another bank (withdraw → swap → repay) |
| `movePosition` | `amount: Amount, bankAddress: PublicKey, destinationAccountPk: PublicKey, processOpts?: ProcessTransactionsClientOpts, txOpts?: TransactionOptions` | `Promise<TransactionSignature[]>` | Move a position between accounts (withdraw + deposit) |

#### Instance Methods: Instruction Builders & Transactions

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `makeDepositIx` | `amount: Amount, bankAddress: PublicKey, depositOpts?: MakeDepositIxOpts` | `Promise<InstructionsWrapper>` | Build deposit instructions |
| `makeDepositTx` | `amount: Amount, bankAddress: PublicKey, depositOpts?: MakeDepositIxOpts` | `Promise<ExtendedTransaction>` | Build a versioned deposit transaction |
| `makeWithdrawIx` | `amount: Amount, bankAddress: PublicKey, withdrawAll?: boolean, withdrawOpts?: MakeWithdrawIxOpts` | `Promise<InstructionsWrapper>` | Build withdraw instructions |
| `makeWithdrawTx` | `amount: Amount, bankAddress: PublicKey, withdrawAll?: boolean, withdrawOpts?: MakeWithdrawIxOpts` | `Promise<TransactionBuilderResult>` | Build withdraw transaction(s) with optional feed updates |
| `makeBorrowIx` | `amount: Amount, bankAddress: PublicKey, borrowOpts?: MakeBorrowIxOpts` | `Promise<InstructionsWrapper>` | Build borrow instructions |
| `makeBorrowTx` | `amount: Amount, bankAddress: PublicKey, borrowOpts?: MakeBorrowIxOpts` | `Promise<TransactionBuilderResult>` | Build borrow transaction(s) with optional feed updates |
| `makeRepayIx` | `amount: Amount, bankAddress: PublicKey, repayAll?: boolean, repayOpts?: MakeRepayIxOpts` | `Promise<InstructionsWrapper>` | Build repay instructions |
| `makeRepayTx` | `amount: Amount, bankAddress: PublicKey, repayAll?: boolean, repayOpts?: MakeRepayIxOpts` | `Promise<ExtendedTransaction>` | Build repay transaction |
| `makeLoopTxV2` | `props: LoopTxProps` | `Promise<FlashloanActionResult>` | Build loop flashloan transaction bundle |
| `makeRepayWithCollatTxV2` | `props: RepayWithCollateralProps` | `Promise<FlashloanActionResult>` | Build repay-with-collateral flashloan transaction bundle |
| `buildFlashLoanTx` | `args: FlashLoanArgs, lookupTables?: AddressLookupTableAccount[], authority?: PublicKey` | `Promise<ExtendedV0Transaction>` | Build the versioned flashloan transaction |

#### Instance Methods: Utilities & Simulation

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `simulateBorrowLendTransaction` | `txs: (VersionedTransaction | Transaction)[], banksToInspect: PublicKey[], healthSimOptions?: { enabled: boolean; mandatoryBanks: PublicKey[]; excludedBanks: PublicKey[] }` | `Promise<SimulationResult>` | Simulate transactions and return previewed account & bank state |
| `makeUpdateFeedIx` | `newBanksPk: PublicKey[], txLandingBuffer?: number` | `Promise<{ instructions: TransactionInstruction[]; luts: AddressLookupTableAccount[] }>` | Build oracle update (crank/pull) instructions if required |
| `makePulseHealthIx` | `mandatoryBanks?: PublicKey[], excludedBanks?: PublicKey[]` | `Promise<InstructionsWrapper>` | Build health pulse instructions for on-chain health cache |
| `reload` | `()` | `Promise<void>` | Reload on-chain account data into the wrapper |

#### Properties

```typescript
interface MarginfiAccountWrapper {
  // Identification
  address: PublicKey;
  authority: PublicKey;

  // State
  balances: Balance[];
  activeBalances: Balance[];

  // Flags
  isDisabled: boolean;
  isFlashLoanEnabled: boolean;

  // Associated client/group
  client: MarginfiClient;
  group: MarginfiGroup;
}
```

### Bank

Represents a lending pool for a specific token. The SDK exposes `Bank` as a concrete class with static helpers for decoding/parsing, conversion helpers, and instance methods for computations and transaction-ready values.

#### Static Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `decodeBankRaw` | `encoded: Buffer, idl: MarginfiIdlType` | `BankRaw` | Decode raw account buffer into bank raw representation |
| `fromBuffer` | `bankPk: PublicKey, rawData: Buffer, idl: MarginfiIdlType, feedIdMap?: PythPushFeedIdMap` | `Bank` | Parse raw buffer and return a `Bank` instance |
| `fromBankType` | `bankType: BankType` | `Bank` | Create a `Bank` instance from a plain `BankType` object (used for conversions) |
| `fromAccountParsed` | `address: PublicKey, accountParsed: BankRaw, feedIdMap?: PythPushFeedIdMap, bankMetadata?: BankMetadata` | `Bank` | Create `Bank` from parsed on-chain data |
| `withEmodeWeights` | `bank: Bank, emodeWeights: { assetWeightMaint: BN; assetWeightInit: BN }` | `Bank` | Return a copy of `bank` with emode-adjusted weights |
| `getPrice` | `oraclePrice: OraclePrice, priceBias?: PriceBias, weightedPrice?: boolean` | `BN` | Compute price taking bias / weighting into account |
| `computeQuantityFromUsdValue` | `oraclePrice: OraclePrice, usdValue: BN, priceBias: PriceBias, weightedPrice: boolean` | `BN` | Convert USD value to token native quantity using oracle price |

#### Instance Methods: Conversions & Quantities

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getTotalAssetQuantity` | `()` | `BN` | Get total deposited assets (native units) |
| `getTotalLiabilityQuantity` | `()` | `BN` | Get total borrowed liabilities (native units) |
| `getAssetQuantity` | `assetShares: BN` | `BN` | Convert asset shares to native quantity |
| `getLiabilityQuantity` | `liabilityShares: BN` | `BN` | Convert liability shares to native quantity |
| `getAssetShares` | `assetQuantity: BN` | `BN` | Convert native quantity to asset shares |
| `getLiabilityShares` | `liabilityQuantity: BN` | `BN` | Convert native quantity to liability shares |

#### Instance Methods: Pricing, Value & Weights

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `computeAssetUsdValue` | `oraclePrice: OraclePrice, assetShares: BN, marginRequirementType: MarginRequirementType, priceBias: PriceBias` | `BN` | Compute USD value of asset shares |
| `computeLiabilityUsdValue` | `oraclePrice: OraclePrice, liabilityShares: BN, marginRequirementType: MarginRequirementType, priceBias: PriceBias` | `BN` | Compute USD value of liability shares |
| `computeUsdValue` | `oraclePrice: OraclePrice, quantity: BN, priceBias: PriceBias, weightedPrice: boolean, weight?: BN, scaleToBase?: boolean` | `BN` | Generic quantity → USD converter with weighting/scale options |
| `getAssetWeight` | `marginRequirementType: MarginRequirementType, oraclePrice: OraclePrice, ignoreSoftLimits?: boolean, assetWeightInitOverride?: BN` | `BN` | Compute asset weight used for margin calculations |
| `getLiabilityWeight` | `marginRequirementType: MarginRequirementType` | `BN` | Compute liability weight from bank config |

#### Instance Methods: Capacity, Rates & Utilization

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `computeTvl` | `oraclePrice: OraclePrice` | `BN` | Compute total value locked (USD) |
| `computeInterestRates` | `()` | `{ lendingRate: BN; borrowingRate: BN }` | Compute lending/borrowing rates based on utilization and config |
| `computeBaseInterestRate` | `()` | `BN` | Compute base interest rate part |
| `computeUtilizationRate` | `()` | `BN` | Compute utilization rate (assets borrowed / assets supplied) |
| `computeRemainingCapacity` | `()` | `{ depositCapacity: BN; borrowCapacity: BN }` | Compute remaining deposit/borrow capacity given limits |

#### Instance Methods: Utilities

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `describe` | `oraclePrice: OraclePrice` | `string` | Human-readable multi-line description of bank state (debugging) |

#### Properties

```typescript
interface Bank {
  address: PublicKey;
  mint: PublicKey;
  mintDecimals: number;
  group: PublicKey;
  mintRate: number | null;
  mintPrice: number;
  assetShareValue: BN;
  liabilityShareValue: BN;

  liquidityVault: PublicKey;
  liquidityVaultBump: number;
  liquidityVaultAuthorityBump: number;
  insuranceVault: PublicKey;
  insuranceVaultBump: number;
  insuranceVaultAuthorityBump: number;
  feeVault: PublicKey;
  feeVaultBump: number;
  feeVaultAuthorityBump: number;

  collectedInsuranceFeesOutstanding: BN;
  collectedGroupFeesOutstanding: BN;

  lastUpdate: number;
  config: BankConfig;
  totalAssetShares: BN;
  totalLiabilityShares: BN;

  emissionsActiveBorrowing: boolean;
  emissionsActiveLending: boolean;
  emissionsRate: number;
  emissionsMint: PublicKey;
  emissionsRemaining: BN;

  oracleKey: PublicKey;
  emode: EmodeSettings;
  kaminoIntegrationAccounts?: { kaminoReserve: PublicKey; kaminoObligation: PublicKey };
  driftIntegrationAccounts?: { driftSpotMarket: PublicKey; driftUser: PublicKey; driftUserStats: PublicKey };
  solendIntegrationAccounts?: { solendReserve: PublicKey; solendObligation: PublicKey };
  feesDestinationAccount?: PublicKey;
  lendingPositionCount?: BN;
  borrowingPositionCount?: BN;
  tokenSymbol?: string;
}
```

### Balance

Represents a user's position in a specific bank. The SDK exposes `Balance` as a concrete class with helpers for parsing and computations.

#### Static Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `from` | `balanceRaw: BalanceRaw` | `Balance` | Parse raw balance data and return `Balance` instance |
| `fromBalanceType` | `balance: BalanceType` | `Balance` | Create `Balance` from a plain `BalanceType` object |
| `createEmpty` | `bankPk: PublicKey` | `Balance` | Create an empty (zeroed) balance for a bank |

#### Instance Methods: Value & Quantity

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `computeUsdValue` | `bank: Bank, oraclePrice: OraclePrice, marginRequirementType?: MarginRequirementType` | `{ assets: BN, liabilities: BN }` | Compute USD value of this balance (assets & liabilities) |
| `getUsdValueWithPriceBias` | `bank: Bank, oraclePrice: OraclePrice, marginRequirementType?: MarginRequirementType` | `{ assets: BN, liabilities: BN }` | Compute USD value respecting price bias rules |
| `computeQuantity` | `bank: Bank` | `{ assets: BN, liabilities: BN }` | Convert shares to native token quantities |
| `computeQuantityUi` | `bank: Bank` | `{ assets: BN, liabilities: BN }` | Convert quantities to UI-friendly decimals |

#### Instance Methods: Emissions & Utilities

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `computeTotalOutstandingEmissions` | `bank: Bank` | `BN` | Compute total emissions outstanding for this balance |
| `computeClaimedEmissions` | `bank: Bank, currentTimestamp: number` | `BN` | Compute emissions already claimable/claimed up to `currentTimestamp` |
| `describe` | `bank: Bank, oraclePrice: OraclePrice` | `string` | Human-readable description of the balance (debugging) |

#### Properties

```typescript
interface Balance {
  active: boolean;
  bankPk: PublicKey;
  assetShares: BN;
  liabilityShares: BN;
  emissionsOutstanding: BN;
  lastUpdate: number;
}
```

### NodeWallet

`NodeWallet` is a minimal wrapper around a `Keypair` that implements the methods required by the SDK for signing transactions.

```typescript
class NodeWallet {
  constructor(keypair: Keypair)

  // Convenience factory
  static fromKeypair(keypair: Keypair): NodeWallet

  // Public key accessor
  publicKey: PublicKey;

  // Sign a single transaction (versioned or legacy)
  async signTransaction(tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction>

  // Sign multiple transactions
  async signAllTransactions(txs: (Transaction | VersionedTransaction)[]): Promise<(Transaction | VersionedTransaction)[]>

  // Return the underlying Keypair
  toKeypair(): Keypair
}
```

#### Usage

```typescript
import { NodeWallet } from "@mrgnlabs/mrgn-common";
const wallet = new NodeWallet(keypair);
// or
const wallet = NodeWallet.fromKeypair(keypair);
```

#### Instance Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `signTransaction` | `tx: Transaction | VersionedTransaction` | `Promise<Transaction | VersionedTransaction>` | Sign a single transaction with the wallet's keypair |
| `signAllTransactions` | `txs: (Transaction | VersionedTransaction)[]` | `Promise<(Transaction | VersionedTransaction)[]>` | Sign multiple transactions (used when bundling) |
| `toKeypair` | `()` | `Keypair` | Return the underlying `Keypair` for low-level uses |

#### Properties

```typescript
interface NodeWallet {
  publicKey: PublicKey;
}
```

## Error Codes

```typescript
enum ErrorCode {
  // Core
  InternalLogicError = 6000,

  // Bank
  BankNotFound = 6001,
  LendingAccountBalanceNotFound = 6002,
  BankAssetCapacityExceeded = 6003,
  BankAlreadyExists = 6011,
  AccountNotBankrupt = 6013,
  BankLiabilityCapacityExceeded = 6027,

  // Risk engine validation
  RiskEngineInitRejected = 6009,

  // Permission errors
  AccountDisabled = 6035,
  Unauthorized = 6042,

  // Oracle errors
  PythPushStalePrice = 6050,
  ZeroAssetPrice = 6057,
  OracleNotSetup = 6031,

  // Liquidation errors
  OverliquidationAttempt = 6005,
  TooSevereLiquidation = 6071,
  WorseHealthPostLiquidation = 6072,
  UnexpectedLiquidationState = 6085,

  // Protocol errors
  ProtocolPaused = 6080,
  ProtocolNotPaused = 6083,

  // Kamino integration errors
  WrongAssetTagForStandardInstructions = 6200,
  WrongAssetTagForKaminoInstructions = 6201,
  KaminoReserveMintAddressMismatch = 6203,
}
```

## SDK Constants

These constants are exported from `@mrgnlabs/marginfi-client-v2`:

### PDA Seeds

| Constant | Value | Description |
|----------|-------|-------------|
| `PDA_BANK_LIQUIDITY_VAULT_AUTH_SEED` | `"liquidity_vault_auth"` | Liquidity vault authority seed |
| `PDA_BANK_INSURANCE_VAULT_AUTH_SEED` | `"insurance_vault_auth"` | Insurance vault authority seed |
| `PDA_BANK_FEE_VAULT_AUTH_SEED` | `"fee_vault_auth"` | Fee vault authority seed |

### Oracle Configuration

| Constant | Value | Description |
|----------|-------|-------------|
| `PYTH_PRICE_CONF_INTERVALS` | `2.12` | Pyth confidence interval |
| `SWB_PRICE_CONF_INTERVALS` | `1.96` | Switchboard confidence interval |
| `MAX_CONFIDENCE_INTERVAL_RATIO` | `0.05` | Max confidence ratio |
| `DEFAULT_ORACLE_MAX_AGE` | `60` | Max oracle age (seconds) |
| `USDC_DECIMALS` | `6` | USDC decimal places |

### Account Flags

| Constant | Value | Description |
|----------|-------|-------------|
| `DISABLED_FLAG` | `1 << 0` | Account disabled |
| `FLASHLOAN_ENABLED_FLAG` | `1 << 2` | Flash loans enabled |
| `TRANSFER_AUTHORITY_ALLOWED_FLAG` | `1 << 3` | Authority transfer allowed |

## Using SDK Configuration

### Get Configuration Programmatically

```typescript
import { getConfig, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";

// Get production config
const config = getConfig("production");
console.log("Program ID:", config.programId.toBase58());
console.log("Group:", config.groupPk.toBase58());

// Or other environments
const alphaConfig = getConfig("alpha");
const devConfig = getConfig("dev");
```

### Fetch Client with Config

```typescript
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";
import { Connection } from "@solana/web3.js";
import { NodeWallet } from "@mrgnlabs/mrgn-common";

const config = getConfig("production");
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = NodeWallet.local();

const client = await MarginfiClient.fetch(config, wallet, connection);
```

## Usage Examples

### Initialize Client

```typescript
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import { Connection } from "@solana/web3.js";

const config = getConfig("production");
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = NodeWallet.local();

const client = await MarginfiClient.fetch(config, wallet, connection);
```

### Create Account and Deposit

```typescript
// Create account
const account = await client.createMarginfiAccount();

// Get bank
const solBank = client.getBankByTokenSymbol("SOL");
if (!solBank) throw new Error("SOL bank not found");

// Deposit 1 SOL (denominated units)
const sig = await account.deposit(1, solBank.address);
console.log("Deposit signature:", sig);
```

### Borrow and Repay

```typescript
const usdcBank = client.getBankByTokenSymbol("USDC");
if (!usdcBank) throw new Error("USDC bank not found");

// Borrow 1 USDC (denominated units)
const borrowSig = await account.borrow(1, usdcBank.address);

// Repay all borrowed amount
const repaySig = await account.repay(0, usdcBank.address, true);
```

### Flash Loan Example

```typescript
// Get bank for flash loan
const bank = client.getBankByTokenSymbol("USDC");
if (!bank) throw new Error("Bank not found");

// Create your arbitrage/liquidation instructions
const arbIxs: TransactionInstruction[] = [
  // Your custom instructions here
];

// Execute flash loan
const sig = await account.flashLoan({ ixs: arbIxs });
```

### Fetch All User Accounts

```typescript
const accounts = await client.getMarginfiAccountsForAuthority(wallet.publicKey);

for (const account of accounts) {
  console.log("Account:", account.address.toBase58());
  console.log("Active balances:", account.activeBalances.length);
}
```