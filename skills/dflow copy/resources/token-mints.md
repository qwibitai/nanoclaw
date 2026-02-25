# Common Solana Token Mints

Reference for commonly used token mint addresses on Solana.

## Native & Wrapped

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| Wrapped SOL | `So11111111111111111111111111111111111111112` | 9 |

## Stablecoins

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | 6 |
| USDS | `USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA` | 6 |

## Popular Tokens

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | 6 |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 5 |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` | 6 |
| POPCAT | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` | 9 |
| FARTCOIN | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | 6 |
| AI16Z | `HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC` | 9 |
| PENGU | `2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv` | 6 |

## DeFi Tokens

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| RAY (Raydium) | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | 6 |
| ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` | 6 |
| MNGO (Mango) | `MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac` | 6 |
| SRM (Serum) | `SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt` | 6 |

## Liquid Staking

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| mSOL (Marinade) | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | 9 |
| stSOL (Lido) | `7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj` | 9 |
| jitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` | 9 |
| bSOL (Blaze) | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` | 9 |

## Wrapped Assets

| Token | Mint Address | Decimals |
|-------|--------------|----------|
| wETH (Wormhole) | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` | 8 |
| wBTC (Wormhole) | `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` | 8 |

## Amount Scaling

To convert human-readable amounts to scaled integers:

```typescript
function toScaledAmount(amount: number, decimals: number): string {
  return Math.floor(amount * Math.pow(10, decimals)).toString();
}

function fromScaledAmount(scaledAmount: string, decimals: number): number {
  return parseInt(scaledAmount) / Math.pow(10, decimals);
}

// Examples
toScaledAmount(1, 9);      // "1000000000" (1 SOL)
toScaledAmount(100, 6);    // "100000000" (100 USDC)
toScaledAmount(0.5, 9);    // "500000000" (0.5 SOL)

fromScaledAmount("1000000000", 9);  // 1 (SOL)
fromScaledAmount("100000000", 6);   // 100 (USDC)
```

## Token Constants

```typescript
// Common token mints
export const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
} as const;

// Token decimals
export const DECIMALS: Record<string, number> = {
  [TOKENS.SOL]: 9,
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
  [TOKENS.JUP]: 6,
  [TOKENS.BONK]: 5,
  [TOKENS.WIF]: 6,
  [TOKENS.RAY]: 6,
  [TOKENS.ORCA]: 6,
  [TOKENS.MSOL]: 9,
  [TOKENS.JITOSOL]: 9,
};
```

## Fetching Token Info

Use DFlow's token endpoints to get up-to-date token lists:

```typescript
// Get all supported tokens
const tokens = await fetch("https://quote-api.dflow.net/tokens", {
  headers: { "x-api-key": API_KEY }
}).then(r => r.json());

// Get tokens with decimals
const tokensWithDecimals = await fetch(
  "https://quote-api.dflow.net/tokens-with-decimals",
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());
```

## Verifying Token Mints

Always verify token mints before trading:

```typescript
import { PublicKey } from "@solana/web3.js";

function isValidMint(mint: string): boolean {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

// Verify against known tokens
function isKnownToken(mint: string): boolean {
  return Object.values(TOKENS).includes(mint as any);
}
```
