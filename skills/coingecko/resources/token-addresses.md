# Common Solana Token Addresses

Reference for commonly used Solana token mint addresses.

## Stablecoins

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| USD Coin | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| Tether USD | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |
| USDS | USDS | `USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA` | 6 |
| PayPal USD | PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | 6 |
| DAI | DAI | `EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCCi3gUvuJrcc` | 8 |

## Native & Wrapped SOL

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Wrapped SOL | SOL | `So11111111111111111111111111111111111111112` | 9 |

## Liquid Staking Tokens (LSTs)

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Marinade Staked SOL | mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | 9 |
| Jito Staked SOL | JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` | 9 |
| BlazeStake SOL | bSOL | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` | 9 |
| Lido Staked SOL | stSOL | `7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj` | 9 |
| Sanctum Infinity | INF | `5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm` | 9 |

## DeFi Protocol Tokens

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Jupiter | JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | 6 |
| Raydium | RAY | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | 6 |
| Orca | ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` | 6 |
| Marinade | MNDE | `MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey` | 9 |
| Drift | DRIFT | `DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7` | 6 |
| Pyth Network | PYTH | `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` | 6 |
| Jito | JTO | `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` | 9 |
| Tensor | TNSR | `TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6` | 9 |

## Memecoins

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Bonk | BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 5 |
| dogwifhat | WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` | 6 |
| Popcat | POPCAT | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` | 9 |
| Book of Meme | BOME | `ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82` | 6 |
| Cat in a dogs world | MEW | `MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5` | 5 |
| Gigachad | GIGA | `63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9` | 5 |

## Wrapped Tokens

| Token | Symbol | Mint Address | Decimals |
|-------|--------|--------------|----------|
| Wrapped ETH (Wormhole) | WETH | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` | 8 |
| Wrapped BTC (Wormhole) | WBTC | `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` | 8 |

## TypeScript Constants

```typescript
export const SOLANA_TOKENS = {
  // Stablecoins
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  USDS: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',

  // Native
  SOL: 'So11111111111111111111111111111111111111112',

  // LSTs
  mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',

  // DeFi
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',

  // Memecoins
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
} as const;

export type SolanaToken = keyof typeof SOLANA_TOKENS;
```

## Notes

- Token addresses are case-sensitive
- Decimals vary by token (check before formatting amounts)
- Wrapped SOL (`So11...112`) is used for DEX trading
- Some tokens have multiple versions (bridged vs native)
- Always verify addresses before use in production
