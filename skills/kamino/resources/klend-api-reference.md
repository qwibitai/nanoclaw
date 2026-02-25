# Kamino Lending SDK (klend-sdk) API Reference

Complete API reference for `@kamino-finance/klend-sdk`.

## Installation

```bash
npm install @kamino-finance/klend-sdk
# or
yarn add @kamino-finance/klend-sdk
```

## Core Classes

### KaminoMarket

Main entry point for interacting with Kamino lending markets.

```typescript
import { KaminoMarket } from "@kamino-finance/klend-sdk";
```

#### Static Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `load` | `connection: Connection, marketAddress: PublicKey, commitment?: Commitment` | `Promise<KaminoMarket>` | Load market with basic data |

#### Instance Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `loadReserves` | `()` | `Promise<void>` | Load all reserve data |
| `refreshAll` | `()` | `Promise<void>` | Refresh all data including obligations |
| `getReserve` | `symbolOrMint: string \| PublicKey` | `KaminoReserve \| undefined` | Get reserve by symbol or mint |
| `getReserves` | `()` | `KaminoReserve[]` | Get all reserves |
| `getUserVanillaObligation` | `wallet: PublicKey` | `Promise<KaminoObligation \| null>` | Get user's vanilla obligation |
| `getAllUserObligations` | `wallet: PublicKey` | `Promise<KaminoObligation[]>` | Get all user obligations |
| `getAllUserObligationsForReserve` | `wallet: PublicKey, reserve: KaminoReserve` | `Promise<KaminoObligation[]>` | Get obligations for specific reserve |
| `getObligationByWallet` | `wallet: PublicKey` | `KaminoObligation \| undefined` | Get cached obligation |
| `isReserveInObligation` | `obligation: KaminoObligation, reserve: KaminoReserve` | `boolean` | Check if reserve is in obligation |

#### Properties

```typescript
interface KaminoMarket {
  connection: Connection;
  address: PublicKey;
  state: LendingMarket;
  reserves: Map<string, KaminoReserve>;
  obligations: Map<string, KaminoObligation>;
}
```

### KaminoAction

Builder for lending transactions.

```typescript
import { KaminoAction } from "@kamino-finance/klend-sdk";
```

#### Static Build Methods

All build methods return `Promise<KaminoAction>`:

| Method | Key Parameters | Description |
|--------|----------------|-------------|
| `buildDepositTxns` | `market, amount, symbol, wallet, obligation` | Build deposit transaction |
| `buildBorrowTxns` | `market, amount, symbol, wallet, obligation` | Build borrow transaction |
| `buildRepayTxns` | `market, amount \| "max", symbol, wallet, obligation` | Build repay transaction |
| `buildWithdrawTxns` | `market, amount \| "max", symbol, wallet, obligation` | Build withdraw transaction |
| `buildLiquidateTxns` | `market, repayAmount, repaySymbol, withdrawSymbol, obligationOwner, liquidator, obligation` | Build liquidation transaction |
| `buildDepositAndBorrowTxns` | `market, depositAmount, depositSymbol, borrowAmount, borrowSymbol, wallet, obligation` | Combined deposit + borrow |
| `buildRepayAndWithdrawTxns` | `market, repayAmount, repaySymbol, withdrawAmount, withdrawSymbol, wallet, obligation` | Combined repay + withdraw |

#### Full Method Signatures

```typescript
// Deposit
static async buildDepositTxns(
  kaminoMarket: KaminoMarket,
  amount: string,
  symbol: string,
  wallet: PublicKey,
  obligation: ObligationType,
  extraComputeBudget?: number,
  includeAtaIxns?: boolean,
  referrer?: PublicKey,
  currentSlot?: number,
  commitment?: Commitment
): Promise<KaminoAction>;

// Borrow
static async buildBorrowTxns(
  kaminoMarket: KaminoMarket,
  amount: string,
  symbol: string,
  wallet: PublicKey,
  obligation: ObligationType,
  extraComputeBudget?: number,
  includeAtaIxns?: boolean,
  includeDepositForFees?: boolean,
  referrer?: PublicKey,
  currentSlot?: number,
  commitment?: Commitment
): Promise<KaminoAction>;

// Repay
static async buildRepayTxns(
  kaminoMarket: KaminoMarket,
  amount: string | "max",
  symbol: string,
  wallet: PublicKey,
  obligation: ObligationType,
  extraComputeBudget?: number,
  includeAtaIxns?: boolean,
  referrer?: PublicKey,
  commitment?: Commitment
): Promise<KaminoAction>;

// Withdraw
static async buildWithdrawTxns(
  kaminoMarket: KaminoMarket,
  amount: string | "max",
  symbol: string,
  wallet: PublicKey,
  obligation: ObligationType,
  extraComputeBudget?: number,
  includeAtaIxns?: boolean,
  referrer?: PublicKey,
  commitment?: Commitment
): Promise<KaminoAction>;

// Liquidate
static async buildLiquidateTxns(
  kaminoMarket: KaminoMarket,
  repayAmount: string,
  repaySymbol: string,
  withdrawSymbol: string,
  obligationOwner: PublicKey,
  liquidator: PublicKey,
  obligation: ObligationType,
  extraComputeBudget?: number,
  includeAtaIxns?: boolean,
  commitment?: Commitment
): Promise<KaminoAction>;
```

#### Instance Properties

```typescript
interface KaminoAction {
  setupIxs: TransactionInstruction[];       // Setup instructions (ATA creation, etc.)
  lendingIxs: TransactionInstruction[];     // Main lending instructions
  cleanupIxs: TransactionInstruction[];     // Cleanup instructions
  preTxnIxs: TransactionInstruction[];      // Pre-transaction instructions
  postTxnIxs: TransactionInstruction[];     // Post-transaction instructions
  lookupTables: AddressLookupTableAccount[]; // Address lookup tables
}
```

### KaminoObligation

Represents a user's lending position.

```typescript
interface KaminoObligation {
  state: Obligation;
  address: PublicKey;
  deposits: ObligationCollateral[];
  borrows: ObligationLiquidity[];
  refreshedStats: ObligationStats;
}

interface ObligationStats {
  borrowedValue: Decimal;
  depositedValue: Decimal;
  borrowLimit: Decimal;
  liquidationThreshold: Decimal;
  netAccountValue: Decimal;
  positions: number;
}

interface ObligationCollateral {
  depositReserve: PublicKey;
  depositedAmount: BN;
  marketValue: Decimal;
}

interface ObligationLiquidity {
  borrowReserve: PublicKey;
  borrowedAmountSf: BN;
  marketValue: Decimal;
}
```

### KaminoReserve

Represents a lending reserve (asset pool).

```typescript
interface KaminoReserve {
  address: PublicKey;
  state: Reserve;
  stats: ReserveStats;
  config: ReserveConfig;
}

interface ReserveStats {
  // Amounts
  totalDepositsWads: BN;
  totalBorrowsWads: BN;
  availableLiquidityWads: BN;

  // Rates
  supplyInterestAPY: number;
  borrowInterestAPY: number;
  utilizationRate: number;

  // Collateral factors
  loanToValueRatio: number;
  liquidationThreshold: number;
  liquidationBonus: number;

  // Prices
  price: Decimal;
  decimals: number;
  symbol: string;
  mint: PublicKey;
}
```

### VanillaObligation

Standard obligation type.

```typescript
import { VanillaObligation, PROGRAM_ID } from "@kamino-finance/klend-sdk";

const obligation = new VanillaObligation(PROGRAM_ID);
```

## Obligation Types

```typescript
// Standard vanilla obligation
const vanilla = new VanillaObligation(PROGRAM_ID);

// Elevated obligation (higher borrowing limits)
const elevated = new ElevatedObligation(PROGRAM_ID, obligationTag);

// Isolated obligation (for isolated pairs)
const isolated = new IsolatedObligation(PROGRAM_ID, collateralReserve, borrowReserve);
```

## Leverage Module

```typescript
import {
  getLeverageDepositIxns,
  getLeverageWithdrawIxns,
  calculateLeverageMultiplier,
  getMaxLeverage,
  simulateLeveragePosition
} from "@kamino-finance/klend-sdk/leverage";
```

### Leverage Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `getLeverageDepositIxns` | `market, wallet, collateralToken, borrowToken, amount, params, obligation` | `Promise<{instructions, lookupTables}>` | Build leverage deposit |
| `getLeverageWithdrawIxns` | `market, wallet, collateralToken, borrowToken, amount, obligation` | `Promise<{instructions, lookupTables}>` | Build leverage withdraw |
| `calculateLeverageMultiplier` | `market, collateralToken, borrowToken, amount, targetLeverage` | `Promise<LeverageParams>` | Calculate leverage parameters |
| `getMaxLeverage` | `market, collateralToken, borrowToken` | `number` | Get maximum leverage for pair |
| `simulateLeveragePosition` | `market, collateralToken, borrowToken, amount, leverage` | `LeverageSimulation` | Simulate position |

### LeverageParams Type

```typescript
interface LeverageParams {
  targetLeverage: number;
  borrowAmount: Decimal;
  collateralAmount: Decimal;
  flashLoanAmount: Decimal;
  swapAmount: Decimal;
  minReceived: Decimal;
  route: SwapRoute;
}

interface LeverageSimulation {
  entryPrice: Decimal;
  liquidationPrice: Decimal;
  healthFactor: number;
  effectiveLeverage: number;
  totalCollateral: Decimal;
  totalBorrowed: Decimal;
}
```

## Obligation Orders Module

```typescript
import {
  createLtvBasedOrder,
  createPriceBasedOrder,
  cancelOrder,
  getActiveOrders,
  LtvOrderType,
  PriceOrderType
} from "@kamino-finance/klend-sdk/obligation_orders";
```

### LTV-Based Orders

```typescript
enum LtvOrderType {
  REPAY_ON_HIGH_LTV = "repay_high_ltv",
  WITHDRAW_ON_LOW_LTV = "withdraw_low_ltv",
  ADD_COLLATERAL_ON_HIGH_LTV = "add_collateral_high_ltv",
}

interface LtvOrderParams {
  type: LtvOrderType;
  triggerLtv: number;          // 0-1 (e.g., 0.8 for 80%)
  repayToken?: string;
  repayAmount?: string;
  withdrawToken?: string;
  withdrawAmount?: string;
  collateralToken?: string;
  collateralAmount?: string;
}

async function createLtvBasedOrder(
  market: KaminoMarket,
  wallet: PublicKey,
  obligation: ObligationType,
  params: LtvOrderParams
): Promise<TransactionInstruction>;
```

### Price-Based Orders

```typescript
enum PriceOrderType {
  STOP_LOSS = "stop_loss",
  TAKE_PROFIT = "take_profit",
  LIMIT_ORDER = "limit_order",
}

interface PriceOrderParams {
  type: PriceOrderType;
  tokenSymbol: string;
  triggerPrice: string;
  action: "repay" | "withdraw" | "deposit" | "borrow";
  amount?: string;
}

async function createPriceBasedOrder(
  market: KaminoMarket,
  wallet: PublicKey,
  obligation: ObligationType,
  params: PriceOrderParams
): Promise<TransactionInstruction>;
```

### Order Management

```typescript
// Get active orders
const orders = await getActiveOrders(market, wallet);

// Cancel order
const cancelIx = await cancelOrder(market, wallet, orderId);
```

## Vault Module

For kToken vault operations.

```typescript
import { KaminoVault } from "@kamino-finance/klend-sdk";
```

### KaminoVault Class

```typescript
class KaminoVault {
  // Load vault
  static async load(connection: Connection, vaultAddress: PublicKey): Promise<KaminoVault>;

  // Get vault data
  getSharePrice(): Decimal;
  getTotalDeposits(): Decimal;
  getUnderlyingToken(): PublicKey;
  getKTokenMint(): PublicKey;

  // Build transactions
  buildDepositTxns(amount: Decimal, wallet: PublicKey): Promise<TransactionInstruction[]>;
  buildWithdrawTxns(shares: Decimal, wallet: PublicKey): Promise<TransactionInstruction[]>;
}
```

## Staking Integration

```typescript
import { StandardStakePool, UnstakingPool } from "@kamino-finance/klend-sdk";
```

### Stake Pool Operations

```typescript
// Load stake pool
const stakePool = await StandardStakePool.load(connection, poolAddress);

// Stake tokens
const stakeIxs = await stakePool.buildStakeTxns(amount, wallet);

// Unstake
const unstakeIxs = await stakePool.buildUnstakeTxns(amount, wallet);

// Get stake info
const userStake = await stakePool.getUserStake(wallet);
const apy = stakePool.getCurrentAPY();
```

## Utility Functions

```typescript
import {
  getObligationAddress,
  getReserveAddress,
  findObligationByWallet,
  calculateHealthFactor,
  calculateBorrowCapacity,
  formatAmount
} from "@kamino-finance/klend-sdk/utils";
```

### Address Derivation

```typescript
// Get obligation PDA
const obligationAddress = getObligationAddress(
  wallet,
  marketAddress,
  obligationType,
  programId
);

// Get reserve address from mint
const reserveAddress = getReserveAddress(
  marketAddress,
  mintAddress,
  programId
);
```

### Calculations

```typescript
// Calculate health factor
const healthFactor = calculateHealthFactor(
  borrowedValue,
  borrowLimit
);

// Calculate available borrow capacity
const capacity = calculateBorrowCapacity(
  depositedValue,
  borrowedValue,
  ltvRatio
);
```

## Error Codes

```typescript
enum ErrorCode {
  // Collateral errors
  InsufficientCollateral = 6000,
  CollateralDisabled = 6001,
  DepositLimitExceeded = 6002,

  // Borrow errors
  InsufficientLiquidity = 6010,
  BorrowLimitExceeded = 6011,
  BorrowDisabled = 6012,

  // Position errors
  LiquidationThresholdExceeded = 6020,
  UnhealthyPosition = 6021,

  // Obligation errors
  InvalidObligation = 6030,
  ObligationNotFound = 6031,
  ObligationAlreadyExists = 6032,

  // Reserve errors
  InvalidReserve = 6040,
  ReserveNotFound = 6041,
  ReserveStale = 6042,

  // Oracle errors
  OracleError = 6050,
  StaleOracle = 6051,
  InvalidOraclePrice = 6052,

  // Math errors
  MathOverflow = 6060,
  MathUnderflow = 6061,
}
```

## Constants

```typescript
import {
  PROGRAM_ID,
  MAIN_MARKET,
  LENDING_MARKET_SIZE,
  RESERVE_SIZE,
  OBLIGATION_SIZE,
  SLOTS_PER_YEAR,
  WAD,
  HALF_WAD,
  PERCENT_SCALER
} from "@kamino-finance/klend-sdk";

// Program ID
const PROGRAM_ID = new PublicKey("KLend2g3cP87ber41qQDzWpAFuqP2tCxDqC8S3k7L1U");

// Main lending market
const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

// Scaling constants
const WAD = new BN(10).pow(new BN(18));
const SLOTS_PER_YEAR = 63072000;
```

## TypeScript Types Export

```typescript
import type {
  // Core types
  KaminoMarket,
  KaminoAction,
  KaminoObligation,
  KaminoReserve,
  KaminoVault,

  // Obligation types
  VanillaObligation,
  ElevatedObligation,
  IsolatedObligation,
  ObligationType,

  // Stats types
  ReserveStats,
  ObligationStats,

  // Config types
  ReserveConfig,
  MarketConfig,

  // Leverage types
  LeverageParams,
  LeverageSimulation,

  // Order types
  LtvOrderParams,
  PriceOrderParams,
  LtvOrderType,
  PriceOrderType,

  // Transaction types
  KaminoActionResult,
} from "@kamino-finance/klend-sdk";
```
