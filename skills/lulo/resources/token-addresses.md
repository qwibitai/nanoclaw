# Lulo Supported Token Addresses

Complete list of tokens supported by Lulo on Solana mainnet.

## Stablecoins

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| USD Coin | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| Tether USD | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |
| USDS | USDS | `USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA` | 6 |
| PayPal USD | PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | 6 |

## Native & Wrapped SOL

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Wrapped SOL | SOL | `So11111111111111111111111111111111111111112` | 9 |

## Liquid Staking Tokens (LSTs)

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Marinade Staked SOL | mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | 9 |
| Jito Staked SOL | JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` | 9 |
| BlazeStake Staked SOL | bSOL | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` | 9 |

## Other Supported Tokens

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Jupiter | JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | 6 |
| Bonk | BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 5 |
| Orca | ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` | 6 |

## Minimum Deposit Requirements

| Token Type | Minimum |
|------------|---------|
| Stablecoins (USDC, USDT, USDS, PYUSD) | $100 equivalent |
| SOL | 1 SOL |
| LSTs | 1 token |

## TypeScript Token Constants

```typescript
export const LULO_TOKENS = {
  // Stablecoins
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  USDS: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',

  // Native
  SOL: 'So11111111111111111111111111111111111111112',

  // LSTs
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  BSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',

  // Other
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
} as const;

export const TOKEN_DECIMALS: Record<string, number> = {
  [LULO_TOKENS.USDC]: 6,
  [LULO_TOKENS.USDT]: 6,
  [LULO_TOKENS.USDS]: 6,
  [LULO_TOKENS.PYUSD]: 6,
  [LULO_TOKENS.SOL]: 9,
  [LULO_TOKENS.MSOL]: 9,
  [LULO_TOKENS.JITOSOL]: 9,
  [LULO_TOKENS.BSOL]: 9,
  [LULO_TOKENS.JUP]: 6,
  [LULO_TOKENS.BONK]: 5,
  [LULO_TOKENS.ORCA]: 6,
};

// Helper function to convert human-readable amount to token units
export function toTokenUnits(amount: number, mint: string): number {
  const decimals = TOKEN_DECIMALS[mint] ?? 6;
  return Math.floor(amount * Math.pow(10, decimals));
}

// Helper function to convert token units to human-readable amount
export function fromTokenUnits(units: number, mint: string): number {
  const decimals = TOKEN_DECIMALS[mint] ?? 6;
  return units / Math.pow(10, decimals);
}
```

## Python Token Constants

```python
LULO_TOKENS = {
    # Stablecoins
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USDS": "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
    "PYUSD": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",

    # Native
    "SOL": "So11111111111111111111111111111111111111112",

    # LSTs
    "MSOL": "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "JITOSOL": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "BSOL": "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",

    # Other
    "JUP": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "BONK": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "ORCA": "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
}

TOKEN_DECIMALS = {
    LULO_TOKENS["USDC"]: 6,
    LULO_TOKENS["USDT"]: 6,
    LULO_TOKENS["USDS"]: 6,
    LULO_TOKENS["PYUSD"]: 6,
    LULO_TOKENS["SOL"]: 9,
    LULO_TOKENS["MSOL"]: 9,
    LULO_TOKENS["JITOSOL"]: 9,
    LULO_TOKENS["BSOL"]: 9,
    LULO_TOKENS["JUP"]: 6,
    LULO_TOKENS["BONK"]: 5,
    LULO_TOKENS["ORCA"]: 6,
}

def to_token_units(amount: float, mint: str) -> int:
    """Convert human-readable amount to token units."""
    decimals = TOKEN_DECIMALS.get(mint, 6)
    return int(amount * (10 ** decimals))

def from_token_units(units: int, mint: str) -> float:
    """Convert token units to human-readable amount."""
    decimals = TOKEN_DECIMALS.get(mint, 6)
    return units / (10 ** decimals)
```

## Integrated Protocols

Lulo routes deposits to these protocols for yield optimization:

| Protocol | Description | Website |
|----------|-------------|---------|
| Kamino Finance | Lending and liquidity vaults | [kamino.finance](https://kamino.finance) |
| Drift Protocol | Perpetuals and lending | [drift.trade](https://drift.trade) |
| MarginFi | Lending and borrowing | [marginfi.com](https://marginfi.com) |
| Jupiter | Lending/earn features | [jup.ag](https://jup.ag) |
