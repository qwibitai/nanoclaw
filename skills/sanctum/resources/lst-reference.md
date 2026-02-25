# LST Reference

Complete reference for Liquid Staking Tokens supported by Sanctum.

## Major LSTs

### Native SOL (Wrapped)

```typescript
const SOL = {
  symbol: 'SOL',
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  name: 'Wrapped SOL',
};
```

### INF (Sanctum Infinity)

```typescript
const INF = {
  symbol: 'INF',
  mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  decimals: 9,
  name: 'Sanctum Infinity',
  description: 'Yield-bearing token representing Infinity pool shares',
  features: [
    'Earns weighted average of all LST yields',
    'Earns trading fees from Infinity pool',
    'No lockups - instant liquidity',
    'Reward-bearing (value increases vs SOL)',
  ],
};
```

### Marinade (mSOL)

```typescript
const mSOL = {
  symbol: 'mSOL',
  mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  decimals: 9,
  name: 'Marinade Staked SOL',
  protocol: 'Marinade Finance',
  calculator: 'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP',
};
```

### Jito (jitoSOL)

```typescript
const jitoSOL = {
  symbol: 'jitoSOL',
  mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  decimals: 9,
  name: 'Jito Staked SOL',
  protocol: 'Jito',
  features: ['MEV rewards included'],
};
```

### BlazeStake (bSOL)

```typescript
const bSOL = {
  symbol: 'bSOL',
  mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  decimals: 9,
  name: 'BlazeStake Staked SOL',
  protocol: 'BlazeStake',
};
```

## Partner LSTs

### Jupiter (jupSOL)

```typescript
const jupSOL = {
  symbol: 'jupSOL',
  mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  decimals: 9,
  name: 'Jupiter Staked SOL',
  protocol: 'Jupiter',
  launchedVia: 'Sanctum',
};
```

### Bybit (bbSOL)

```typescript
const bbSOL = {
  symbol: 'bbSOL',
  mint: 'bbso1MfE7KVL7DhqwZ6dVfKrD3oNV1PEykLNM4kk5dD',
  decimals: 9,
  name: 'Bybit Staked SOL',
  protocol: 'Bybit',
  launchedVia: 'Sanctum',
};
```

### Drift (dSOL)

```typescript
const dSOL = {
  symbol: 'dSOL',
  mint: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ',
  decimals: 9,
  name: 'Drift Staked SOL',
  protocol: 'Drift',
  launchedVia: 'Sanctum',
};
```

### Crypto.com (cdcSOL)

```typescript
const cdcSOL = {
  symbol: 'cdcSOL',
  mint: 'CDCSOL_MINT_ADDRESS', // Get from API
  decimals: 9,
  name: 'Crypto.com Staked SOL',
  protocol: 'Crypto.com',
  launchedVia: 'Sanctum',
};
```

## Other Popular LSTs

### Helius (hSOL)

```typescript
const hSOL = {
  symbol: 'hSOL',
  mint: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A',
  decimals: 9,
  name: 'Helius Staked SOL',
  protocol: 'Helius',
};
```

### Power (pwrSOL)

```typescript
const pwrSOL = {
  symbol: 'pwrSOL',
  mint: 'pWrSoLAhue6jUxUMbWaY8izMhNpWfhiJk7M3Fy3p1Kt',
  decimals: 9,
  name: 'Power Staked SOL',
};
```

### Laine (laineSOL)

```typescript
const laineSOL = {
  symbol: 'laineSOL',
  mint: 'LAinEtNLgpmCP9Rvsf5Hn8W6EhNiKLZQti1xfWMLy6X',
  decimals: 9,
  name: 'Laine Staked SOL',
  protocol: 'Laine',
};
```

### Lido (stSOL)

```typescript
const stSOL = {
  symbol: 'stSOL',
  mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  decimals: 9,
  name: 'Lido Staked SOL',
  protocol: 'Lido',
  calculator: '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR',
};
```

## Complete LST Map

```typescript
export const LST_MINTS = {
  // Native
  SOL: 'So11111111111111111111111111111111111111112',

  // Sanctum
  INF: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',

  // Major Protocols
  mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  jitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  stSOL: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',

  // Partner LSTs
  jupSOL: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  bbSOL: 'bbso1MfE7KVL7DhqwZ6dVfKrD3oNV1PEykLNM4kk5dD',
  dSOL: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ',

  // Other Popular
  hSOL: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A',
  pwrSOL: 'pWrSoLAhue6jUxUMbWaY8izMhNpWfhiJk7M3Fy3p1Kt',
  laineSOL: 'LAinEtNLgpmCP9Rvsf5Hn8W6EhNiKLZQti1xfWMLy6X',
} as const;

export type LstSymbol = keyof typeof LST_MINTS;
```

## Getting Current LST List

The definitive list of LSTs is served via the Sanctum API:

```typescript
async function getAllLsts(apiKey: string): Promise<LstMetadata[]> {
  const response = await fetch(
    `https://sanctum-api.ironforge.network/lsts?apiKey=${apiKey}`
  );
  return response.json();
}

// Get LST by symbol or mint
async function getLst(apiKey: string, mintOrSymbol: string): Promise<LstMetadata> {
  const response = await fetch(
    `https://sanctum-api.ironforge.network/lsts/${mintOrSymbol}?apiKey=${apiKey}`
  );
  return response.json();
}
```

## LST Value Calculation

Each LST's SOL value is calculated from its underlying stake pool state:

```typescript
// LST value increases over time as staking rewards accrue
// Example: 1 mSOL might be worth 1.05 SOL after some epochs

interface LstValue {
  lstAmount: bigint;       // LST token amount
  solValue: bigint;        // Equivalent SOL value
  exchangeRate: number;    // LST per SOL rate
}

// The SOL Value Calculator programs perform this conversion on-chain
const SOL_VALUE_CALCULATORS = {
  SPL: 'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF',
  SanctumSpl: 'sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy',
  SanctumSplMulti: 'ssmbu3KZxgonUtjEMCKspZzxvUQCxAFnyh1rcHUeEDo',
  Marinade: 'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP',
  Lido: '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR',
  wSOL: 'wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE',
};
```

## LST Characteristics

### Reward-Bearing vs Rebasing

| Type | Behavior | Examples |
|------|----------|----------|
| **Reward-Bearing** | Value increases over time | mSOL, INF, jitoSOL |
| **Rebasing** | Token count increases | (Less common on Solana) |

Most Solana LSTs are reward-bearing: you hold the same number of tokens, but each token becomes worth more SOL over time.

### Fee Structures

Standard Sanctum LST fees:
- **Withdrawal fees**: 10 bps (0.1%)
- **Epoch fees**: 5% annually (split between operator and Sanctum)

### Security

- Built on audited Solana stake pool program
- 5 independent audits (Halborn, Kudelski, Ottersec, Neodyme, Quantstamp)
- 11-member multisig for program upgrades
- Management authority cannot steal funds

## Fetching User LST Balances

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

async function getLstBalances(
  connection: Connection,
  wallet: PublicKey
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();

  for (const [symbol, mint] of Object.entries(LST_MINTS)) {
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mint),
        wallet
      );
      const account = await getAccount(connection, ata);
      if (account.amount > 0n) {
        balances.set(symbol, account.amount);
      }
    } catch {
      // Account doesn't exist - no balance
    }
  }

  return balances;
}

// Usage
const balances = await getLstBalances(connection, wallet.publicKey);
console.log('mSOL balance:', balances.get('mSOL'));
```

## Popular LST Pairs

Common swap pairs via Sanctum:

| From | To | Use Case |
|------|-------|----------|
| SOL | mSOL | Stake SOL with Marinade |
| SOL | jitoSOL | Stake with MEV rewards |
| SOL | INF | Diversified yield |
| mSOL | jitoSOL | Switch LST protocols |
| Any LST | SOL | Instant unstake |
| Any LST | INF | Add to Infinity pool |
