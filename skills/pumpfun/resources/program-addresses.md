# PumpFun Program Addresses

All program addresses and important accounts for PumpFun protocol.

## Programs

| Program | Address | Description |
|---------|---------|-------------|
| Pump Program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Bonding curve token launches |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Constant product AMM |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | Dynamic fee management |
| Mayhem Program | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | Special token launch mode |

## Global Accounts

| Account | Address | Program |
|---------|---------|---------|
| PumpSwap GlobalConfig | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` | PumpSwap AMM |

## Mayhem Fee Recipients

These addresses are used for Mayhem mode tokens (rotated randomly for load balancing):

| Index | Address |
|-------|---------|
| 0 | `DzPPWKfYYMuHxR98xhPkYSp7KHsLpcLZU8tHCqXjC3HG` |
| 1 | `5AbGBKS6NHKcTFyJaZCk3dbMRNFG3y6kkN4y7Rp3iHCk` |
| 2 | `DWM9EuZ3e9cRYdHYRKwsCqXFKgn4jUNkUPEAyNE2Dxnc` |
| 3 | `9BUPJ65gFVaGQKyXiR6xSE1DdLRqkUMv9HJvL8wGfJaL` |

## External Programs

| Program | Address | Description |
|---------|---------|-------------|
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL Token |
| Token 2022 Program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token Extensions |
| Associated Token Program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | ATA Program |
| Metaplex Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | Token Metadata |
| System Program | `11111111111111111111111111111111` | System |
| Rent Sysvar | `SysvarRent111111111111111111111111111111111` | Rent |

## PDA Seeds Reference

### Pump Program PDAs

```typescript
// Global config
["global"]

// Bonding curve for a token
["bonding-curve", mint.toBuffer()]

// Associated bonding curve (token account)
["associated-bonding-curve", mint.toBuffer()]

// Creator fee vault
["creator-vault", creator.toBuffer()]

// User volume accumulator
["user_volume", user.toBuffer()]
```

### PumpSwap AMM PDAs

```typescript
// Pool account
const indexBuffer = Buffer.alloc(2);
indexBuffer.writeUInt16LE(index);
["pool", indexBuffer, creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()]

// LP token mint
["pool_lp_mint", pool.toBuffer()]

// Pool token account
["pool_token_account", pool.toBuffer(), mint.toBuffer()]

// Creator vault authority
["creator_vault", coinCreator.toBuffer()]

// User volume accumulator
["user_volume", user.toBuffer()]
```

### Pump Fees PDAs

```typescript
// Fee config
["fee_config"]

// Sharing config for a token
["sharing_config", mint.toBuffer()]
```

## TypeScript Constants

```typescript
import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);

export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);

export const PUMP_FEES_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
);

export const MAYHEM_PROGRAM_ID = new PublicKey(
  'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e'
);

export const PUMP_SWAP_GLOBAL_CONFIG = new PublicKey(
  'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw'
);

export const MAYHEM_FEE_RECIPIENTS = [
  new PublicKey('DzPPWKfYYMuHxR98xhPkYSp7KHsLpcLZU8tHCqXjC3HG'),
  new PublicKey('5AbGBKS6NHKcTFyJaZCk3dbMRNFG3y6kkN4y7Rp3iHCk'),
  new PublicKey('DWM9EuZ3e9cRYdHYRKwsCqXFKgn4jUNkUPEAyNE2Dxnc'),
  new PublicKey('9BUPJ65gFVaGQKyXiR6xSE1DdLRqkUMv9HJvL8wGfJaL'),
];

// Token addresses
export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);
```

## Network Endpoints

| Network | RPC Endpoint |
|---------|--------------|
| Mainnet | `https://api.mainnet-beta.solana.com` |
| Devnet | `https://api.devnet.solana.com` |

**Note**: Use a dedicated RPC provider (Helius, QuickNode, etc.) for production applications.
