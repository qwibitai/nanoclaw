---
name: sanctum
creator: raunit-dev
description: Complete Sanctum SDK for liquid staking, LST swaps, and Infinity pool operations on Solana. Use when working with LSTs (mSOL, jitoSOL, bSOL, INF), staking SOL, swapping between liquid staking tokens, or integrating Sanctum's liquidity infrastructure.
---

# Sanctum Development Guide

A comprehensive guide for building Solana applications with Sanctum - Solana's largest LST (Liquid Staking Token) platform powering 1,361+ LSTs.

## Overview

Sanctum provides unified liquid staking infrastructure on Solana:
- **Infinity Pool**: Multi-LST liquidity pool with zero-slippage swaps
- **Router**: Instant LST-to-LST swaps via stake account routing
- **Reserve**: Instant SOL liquidity for LST withdrawals
- **LST Creation**: Launch custom liquid staking tokens
- **INF Token**: Yield-bearing token representing Infinity pool shares

### Key Stats
- 1,361+ LSTs supported
- $1.4B+ in swap volume facilitated
- ~8,000 SOL ($1M+) in fees shared with stakers
- Partners: Jupiter (jupSOL), Bybit (bbSOL), Drift (dSOL), crypto.com (cdcSOL)

## Quick Start

### API Setup

```typescript
const SANCTUM_API_BASE = 'https://sanctum-api.ironforge.network';

// All endpoints require API key
const headers = {
  'Content-Type': 'application/json',
};

// Example: Get all LST metadata
const response = await fetch(
  `${SANCTUM_API_BASE}/lsts?apiKey=${API_KEY}`
);
const lsts = await response.json();
```

### Common LST Addresses

```typescript
const LST_MINTS = {
  // Native SOL (wrapped)
  SOL: 'So11111111111111111111111111111111111111112',

  // Sanctum INF (Infinity pool token)
  INF: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',

  // Major LSTs
  mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',      // Marinade
  jitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // Jito
  bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',      // BlazeStake

  // Partner LSTs
  jupSOL: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',   // Jupiter
  bbSOL: 'bbso1MfE7KVL7DhqwZ6dVfKrD3oNV1PEykLNM4kk5dD',    // Bybit
  dSOL: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ',     // Drift

  // Other popular LSTs
  hSOL: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A',     // Helius
  pwrSOL: 'pWrSoLAhue6jUxUMbWaY8izMhNpWfhiJk7M3Fy3p1Kt',   // Power
  laineSOL: 'LAinEtNLgpmCP9Rvsf5Hn8W6EhNiKLZQti1xfWMLy6X', // Laine
};
```

## Core Concepts

### 1. LST (Liquid Staking Token)

LSTs represent staked SOL that remains liquid. When you stake SOL through a stake pool:
- You receive LST tokens representing your stake
- The stake earns validator rewards
- LSTs can be traded, used in DeFi, or swapped back to SOL

### 2. INF Token

INF is Sanctum's flagship yield-bearing token:
- Represents share of Infinity pool's multi-LST holdings
- **Reward-bearing**: Value increases vs SOL (not rebasing)
- Earns weighted average of all LST yields + trading fees
- No lockups - hold to earn, swap out anytime

```typescript
// INF increases in value over time
// Example: 1 INF deposited at 1.0 SOL might be worth 1.05 SOL later
const infValue = await getInfSolValue(); // Returns current INF/SOL rate
```

### 3. SOL Value Calculators

On-chain programs that convert LST amounts to intrinsic SOL value:

```typescript
// Each LST has a dedicated calculator
const SOL_VALUE_CALCULATORS = {
  SPL: 'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF',
  SanctumSpl: 'sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy',
  SanctumSplMulti: 'ssmbu3KZxgonUtjEMCKspZzxvUQCxAFnyh1rcHUeEDo',
  Marinade: 'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP',
  Lido: '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR',
  wSOL: 'wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE',
};
```

## API Reference

### Base URL
```
https://sanctum-api.ironforge.network
```

All endpoints require `apiKey` query parameter.

### Get LST Metadata

```typescript
// Get all LSTs
GET /lsts?apiKey={key}

// Get specific LST by mint or symbol
GET /lsts/{mintOrSymbol}?apiKey={key}

// Response
interface LstMetadata {
  symbol: string;
  mint: string;
  decimals: number;
  tokenProgram: string;
  logoUri: string;
  name: string;
  tvl: number;         // Total Value Locked
  apy: number;         // Current APY
  holders: number;
}
```

### Get APY Data

```typescript
// Get validator APYs
GET /validators/apy?apiKey={key}

// Response
interface ValidatorApy {
  [validatorId: string]: {
    avgApy: number;
    timeseries: Array<{epoch: number; apy: number}>;
  };
}

// Get LST historical APYs
GET /lsts/{mintOrSymbol}/apys?apiKey={key}&limit={n}

// Response
interface LstApyHistory {
  apys: Array<{
    epoch: number;
    epochEndTs: number;
    apy: number;
  }>;
}
```

### Swap LSTs

```typescript
// Get swap quote and unsigned transaction
GET /swap/token/order?apiKey={key}&inp={inputMint}&out={outputMint}&amt={amount}&mode={ExactIn|ExactOut}&signer={walletPubkey}&slippageBps={bps}

// Response
interface SwapOrderResponse {
  tx: string;           // Base64 encoded transaction
  inpAmt: string;       // Input amount
  outAmt: string;       // Output amount
  source: string;       // Swap source (Infinity, Router, etc.)
  feeAmt: string;       // Fee amount
  feeMint: string;      // Fee token mint
}

// Execute signed swap
POST /swap/token/execute
Body: {
  signedTx: string;     // Base64 signed transaction
  orderResponse: object; // Original order response
}

// Response
interface SwapExecuteResponse {
  txSignature: string;
}
```

### Deposit Stake Account

```typescript
// Convert native stake account to LST
GET /swap/depositStake/order?apiKey={key}&stakeAccount={pubkey}&outputLstMint={mint}&signer={wallet}

POST /swap/depositStake/execute
Body: {
  signedTx: string;
  orderResponse: object;
}
```

### Withdraw to Stake Account

```typescript
// Convert LST back to stake account
GET /swap/withdrawStake/order?apiKey={key}&lstMint={mint}&amount={amount}&signer={wallet}&deactivate={boolean}

POST /swap/withdrawStake/execute
Body: {
  signedTx: string;
  orderResponse: object;
}
```

## TypeScript Integration

### Full Client Implementation

```typescript
import { Connection, PublicKey, Transaction, Keypair } from '@solana/web3.js';

class SanctumClient {
  private apiKey: string;
  private baseUrl = 'https://sanctum-api.ironforge.network';
  private connection: Connection;

  constructor(apiKey: string, connection: Connection) {
    this.apiKey = apiKey;
    this.connection = connection;
  }

  // Get all LSTs
  async getLsts(): Promise<LstMetadata[]> {
    const response = await fetch(
      `${this.baseUrl}/lsts?apiKey=${this.apiKey}`
    );
    return response.json();
  }

  // Get specific LST
  async getLst(mintOrSymbol: string): Promise<LstMetadata> {
    const response = await fetch(
      `${this.baseUrl}/lsts/${mintOrSymbol}?apiKey=${this.apiKey}`
    );
    return response.json();
  }

  // Get swap quote
  async getSwapQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    mode: 'ExactIn' | 'ExactOut';
    signer: string;
    slippageBps?: number;
  }): Promise<SwapOrderResponse> {
    const url = new URL(`${this.baseUrl}/swap/token/order`);
    url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('inp', params.inputMint);
    url.searchParams.set('out', params.outputMint);
    url.searchParams.set('amt', params.amount);
    url.searchParams.set('mode', params.mode);
    url.searchParams.set('signer', params.signer);
    if (params.slippageBps) {
      url.searchParams.set('slippageBps', params.slippageBps.toString());
    }

    const response = await fetch(url.toString());
    return response.json();
  }

  // Execute swap
  async executeSwap(
    orderResponse: SwapOrderResponse,
    signer: Keypair
  ): Promise<string> {
    // Decode and sign transaction
    const txBuffer = Buffer.from(orderResponse.tx, 'base64');
    const transaction = Transaction.from(txBuffer);
    transaction.sign(signer);

    // Send to API
    const response = await fetch(`${this.baseUrl}/swap/token/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signedTx: transaction.serialize().toString('base64'),
        orderResponse,
      }),
    });

    const result = await response.json();
    return result.txSignature;
  }

  // Swap LSTs (convenience method)
  async swapLst(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    signer: Keypair;
    slippageBps?: number;
  }): Promise<string> {
    const quote = await this.getSwapQuote({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      mode: 'ExactIn',
      signer: params.signer.publicKey.toBase58(),
      slippageBps: params.slippageBps || 50,
    });

    return this.executeSwap(quote, params.signer);
  }
}
```

### Usage Examples

```typescript
const connection = new Connection('https://api.mainnet-beta.solana.com');
const sanctum = new SanctumClient(API_KEY, connection);

// Get all LSTs
const lsts = await sanctum.getLsts();
console.log(`Found ${lsts.length} LSTs`);

// Get INF token info
const inf = await sanctum.getLst('INF');
console.log(`INF APY: ${inf.apy}%`);

// Swap 1 SOL to mSOL
const signature = await sanctum.swapLst({
  inputMint: LST_MINTS.SOL,
  outputMint: LST_MINTS.mSOL,
  amount: '1000000000', // 1 SOL (9 decimals)
  signer: wallet,
  slippageBps: 50,
});
console.log('Swap TX:', signature);

// Swap mSOL to INF
const infSwap = await sanctum.swapLst({
  inputMint: LST_MINTS.mSOL,
  outputMint: LST_MINTS.INF,
  amount: '500000000', // 0.5 mSOL
  signer: wallet,
});
```

## Infinity Pool

### How It Works

Infinity is a multi-LST liquidity pool enabling zero-slippage swaps:

1. **SOL Value Calculation**: Each LST's value is calculated from on-chain stake pool state
2. **Fair Pricing**: Swaps execute at intrinsic SOL value (no AMM curves)
3. **Fee Structure**: 8 bps per swap, 10 bps for withdrawals
4. **Fee Distribution**: 90% to LPs (INF holders), 10% to protocol

### Add Liquidity (Get INF)

```typescript
// Deposit SOL or any LST to get INF
async function addLiquidity(
  sanctum: SanctumClient,
  lstMint: string,
  amount: string,
  signer: Keypair
): Promise<string> {
  // Swap LST/SOL for INF
  return sanctum.swapLst({
    inputMint: lstMint,
    outputMint: LST_MINTS.INF,
    amount,
    signer,
  });
}

// Example: Add 10 SOL to Infinity
const tx = await addLiquidity(
  sanctum,
  LST_MINTS.SOL,
  '10000000000',
  wallet
);
```

### Remove Liquidity

```typescript
// Withdraw from Infinity pool
async function removeLiquidity(
  sanctum: SanctumClient,
  outputMint: string,
  infAmount: string,
  signer: Keypair
): Promise<string> {
  // Swap INF for desired LST/SOL
  return sanctum.swapLst({
    inputMint: LST_MINTS.INF,
    outputMint: outputMint,
    amount: infAmount,
    signer,
  });
}

// Example: Withdraw to SOL
const tx = await removeLiquidity(
  sanctum,
  LST_MINTS.SOL,
  '5000000000', // 5 INF
  wallet
);
```

## Router

### How Swaps Work

The Router enables LST-to-LST swaps via stake accounts:

1. **StakeWrappedSol**: Stake SOL into pool, receive LST
2. **WithdrawWrappedSol**: Withdraw undelegated SOL from reserve
3. **DepositStake**: Deposit stake account, receive LST
4. **SwapViaStake**: Route through shared validators

### Fee Structure

| Operation | Fee |
|-----------|-----|
| StakeWrappedSol | 0 bps |
| WithdrawWrappedSol | 1 bps |
| DepositStake | 10 bps (waived for SOL output) |
| SwapViaStake | Varies by route |

### Jupiter Integration

Sanctum Router is integrated with Jupiter. Use Jupiter SDK for optimal routing:

```typescript
import { Jupiter } from '@jup-ag/core';

const jupiter = await Jupiter.load({
  connection,
  cluster: 'mainnet-beta',
  user: wallet.publicKey,
});

// Jupiter automatically routes through Sanctum when optimal
const routes = await jupiter.computeRoutes({
  inputMint: new PublicKey(LST_MINTS.mSOL),
  outputMint: new PublicKey(LST_MINTS.jitoSOL),
  amount: 1_000_000_000n,
  slippageBps: 50,
});
```

## Staking SOL

### Direct Staking

```typescript
// Stake SOL to get LST
async function stakeSol(
  sanctum: SanctumClient,
  lstMint: string,
  solAmount: string,
  signer: Keypair
): Promise<string> {
  return sanctum.swapLst({
    inputMint: LST_MINTS.SOL,
    outputMint: lstMint,
    amount: solAmount,
    signer,
  });
}

// Stake 5 SOL for jupSOL
const tx = await stakeSol(
  sanctum,
  LST_MINTS.jupSOL,
  '5000000000',
  wallet
);
```

### Unstaking (Instant)

```typescript
// Instant unstake via Infinity/Reserve
async function instantUnstake(
  sanctum: SanctumClient,
  lstMint: string,
  amount: string,
  signer: Keypair
): Promise<string> {
  return sanctum.swapLst({
    inputMint: lstMint,
    outputMint: LST_MINTS.SOL,
    amount,
    signer,
  });
}
```

### Delayed Unstaking (Lower Fees)

```typescript
// Withdraw to stake account (requires epoch wait)
async function delayedUnstake(
  sanctum: SanctumClient,
  lstMint: string,
  amount: string,
  signer: Keypair,
  deactivate: boolean = true
): Promise<string> {
  const url = new URL(`${sanctum.baseUrl}/swap/withdrawStake/order`);
  url.searchParams.set('apiKey', sanctum.apiKey);
  url.searchParams.set('lstMint', lstMint);
  url.searchParams.set('amount', amount);
  url.searchParams.set('signer', signer.publicKey.toBase58());
  url.searchParams.set('deactivate', deactivate.toString());

  const response = await fetch(url.toString());
  const orderResponse = await response.json();

  return sanctum.executeSwap(orderResponse, signer);
}
```

## Data Queries

### Get APYs

```typescript
// Get all LST APYs
async function getLstApys(sanctum: SanctumClient): Promise<Map<string, number>> {
  const lsts = await sanctum.getLsts();
  const apyMap = new Map();

  for (const lst of lsts) {
    apyMap.set(lst.symbol, lst.apy);
  }

  return apyMap;
}

// Get specific LST historical APY
async function getLstApyHistory(
  sanctum: SanctumClient,
  lstMint: string,
  limit: number = 30
): Promise<Array<{epoch: number; apy: number}>> {
  const response = await fetch(
    `${sanctum.baseUrl}/lsts/${lstMint}/apys?apiKey=${sanctum.apiKey}&limit=${limit}`
  );
  const data = await response.json();
  return data.apys;
}
```

### Get TVL

```typescript
// Get TVL for specific LSTs
async function getTvl(
  sanctum: SanctumClient,
  symbols: string[]
): Promise<Map<string, number>> {
  const tvlMap = new Map();

  for (const symbol of symbols) {
    const lst = await sanctum.getLst(symbol);
    tvlMap.set(symbol, lst.tvl);
  }

  return tvlMap;
}
```

### Get User Holdings

```typescript
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

async function getUserLstBalances(
  connection: Connection,
  wallet: PublicKey,
  lstMints: string[]
): Promise<Map<string, bigint>> {
  const balances = new Map();

  for (const mint of lstMints) {
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mint),
        wallet
      );
      const account = await getAccount(connection, ata);
      balances.set(mint, account.amount);
    } catch {
      balances.set(mint, 0n);
    }
  }

  return balances;
}
```

## Program IDs

### Core Programs

| Program | ID | Description |
|---------|------|-------------|
| S Controller | `5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx` | Infinity pool management |
| Flat Fee Pricing | `f1tUoNEKrDp1oeGn4zxr7bh41eN6VcfHjfrL3ZqQday` | Fee calculation (deprecated) |
| Flat Slab | `s1b6NRXj6ygNu1QMKXh2H9LUR2aPApAAm1UQ2DjdhNV` | Current fee program |

### SOL Value Calculators

| Calculator | ID |
|------------|------|
| SPL | `sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF` |
| SanctumSpl | `sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy` |
| SanctumSplMulti | `ssmbu3KZxgonUtjEMCKspZzxvUQCxAFnyh1rcHUeEDo` |
| Marinade | `mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP` |
| Lido | `1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR` |
| wSOL | `wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE` |

### Stake Pool Programs

| Program | ID |
|---------|------|
| SanctumSpl Stake Pool | `SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY` |
| SanctumSplMulti Stake Pool | `SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn` |

## Resources

- [Sanctum App](https://app.sanctum.so/)
- [Sanctum Docs](https://learn.sanctum.so/docs)
- [API Documentation](https://learn.sanctum.so/docs/for-developers/sanctum-api)
- [GitHub (Igneous Labs)](https://github.com/igneous-labs)
- [Discord](https://discord.gg/sanctum)

## Skill Structure

```
sanctum/
├── SKILL.md                              # This file
├── resources/
│   ├── api-reference.md                  # Complete API documentation
│   ├── lst-reference.md                  # LST addresses and metadata
│   └── program-ids.md                    # All program addresses
├── examples/
│   ├── lst-swap/README.md                # LST swap examples
│   ├── staking/README.md                 # Staking/unstaking examples
│   ├── infinity-pool/README.md           # Infinity operations
│   └── liquidity/README.md               # Add/remove liquidity
└── docs/
    └── troubleshooting.md                # Common issues
```
