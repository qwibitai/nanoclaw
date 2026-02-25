# Pump Program API Reference

Complete API reference for the Pump bonding curve program.

## Program Information

- **Program ID**: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Network**: Mainnet & Devnet

## Instructions

### create

Creates a new SPL token with a bonding curve.

```typescript
interface CreateArgs {
  name: string;      // Token name
  symbol: string;    // Token symbol
  uri: string;       // Metadata URI
}
```

**Accounts (12)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | mint | Yes | Yes | New token mint keypair |
| 1 | mintAuthority | No | No | Mint authority PDA |
| 2 | bondingCurve | Yes | No | Bonding curve PDA |
| 3 | associatedBondingCurve | Yes | No | Token account for bonding curve |
| 4 | global | No | No | Global config account |
| 5 | mplTokenMetadata | No | No | Metaplex metadata program |
| 6 | metadata | Yes | No | Token metadata account |
| 7 | user | Yes | Yes | Creator/payer |
| 8 | systemProgram | No | No | System program |
| 9 | tokenProgram | No | No | Token program |
| 10 | associatedTokenProgram | No | No | ATA program |
| 11 | rent | No | No | Rent sysvar |

### create_v2

Creates a new Token2022 token with a bonding curve (Mayhem mode support).

```typescript
interface CreateV2Args {
  name: string;
  symbol: string;
  uri: string;
}
```

**Accounts (14)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | mint | Yes | Yes | New token mint |
| 1 | mintAuthority | No | No | Mint authority PDA |
| 2 | bondingCurve | Yes | No | Bonding curve PDA |
| 3 | associatedBondingCurve | Yes | No | Token account |
| 4 | global | No | No | Global config |
| 5 | user | Yes | Yes | Creator/payer |
| 6 | systemProgram | No | No | System program |
| 7 | token2022Program | No | No | Token2022 program |
| 8 | associatedTokenProgram | No | No | ATA program |
| 9 | rent | No | No | Rent sysvar |
| 10 | mayhemProgram | No | No | Mayhem program |
| 11 | mayhemFeeRecipient | Yes | No | Mayhem fee recipient |
| 12 | eventAuthority | No | No | Event authority |
| 13 | program | No | No | Pump program |

### buy

Purchase tokens from the bonding curve with SOL.

```typescript
interface BuyArgs {
  amount: u64;        // Token amount to buy
  maxSolCost: u64;    // Maximum SOL to spend (slippage)
}
```

**Accounts (13)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | global | No | No | Global config |
| 1 | feeRecipient | Yes | No | Protocol fee recipient |
| 2 | mint | No | No | Token mint |
| 3 | bondingCurve | Yes | No | Bonding curve account |
| 4 | associatedBondingCurve | Yes | No | Bonding curve token account |
| 5 | associatedUser | Yes | No | User token account |
| 6 | user | Yes | Yes | Buyer |
| 7 | systemProgram | No | No | System program |
| 8 | tokenProgram | No | No | Token program |
| 9 | rent | No | No | Rent sysvar |
| 10 | creatorVault | Yes | No | Creator fee vault |
| 11 | feeProgram | No | No | Fee program |
| 12 | feeConfig | No | No | Fee config account |

### sell

Sell tokens back to the bonding curve for SOL.

```typescript
interface SellArgs {
  amount: u64;          // Token amount to sell
  minSolOutput: u64;    // Minimum SOL to receive (slippage)
}
```

**Accounts (12)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | global | No | No | Global config |
| 1 | feeRecipient | Yes | No | Protocol fee recipient |
| 2 | mint | No | No | Token mint |
| 3 | bondingCurve | Yes | No | Bonding curve account |
| 4 | associatedBondingCurve | Yes | No | Bonding curve token account |
| 5 | associatedUser | Yes | No | User token account |
| 6 | user | Yes | Yes | Seller |
| 7 | systemProgram | No | No | System program |
| 8 | creatorVault | Yes | No | Creator fee vault |
| 9 | tokenProgram | No | No | Token program |
| 10 | feeProgram | No | No | Fee program |
| 11 | feeConfig | No | No | Fee config account |

### migrate

Migrate completed bonding curve to PumpSwap AMM.

**Note**: This instruction is permissionless - anyone can call it once the bonding curve is complete.

**Accounts**: Various accounts for pool creation on PumpSwap.

### collect_creator_fee

Withdraw accumulated creator fees from vault.

```typescript
// No args - withdraws all accumulated fees
```

**Accounts (3)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | creatorVault | Yes | No | Creator fee vault PDA |
| 1 | creator | Yes | Yes | Creator wallet |
| 2 | systemProgram | No | No | System program |

### extend_account

Extend account size for breaking changes.

**Use when**: BondingCurve account size < 150 bytes

## Account Structures

### Global

```typescript
interface Global {
  initialized: boolean;
  authority: PublicKey;
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: u64;  // 1,073,000,000,000,000
  initialVirtualSolReserves: u64;    // 30,000,000,000 (30 SOL)
  initialRealTokenReserves: u64;     // 793,100,000,000,000
  tokenTotalSupply: u64;             // 1,000,000,000,000,000
  feeBasisPoints: u64;               // 100 (1%)
  creatorFeeBasisPoints: u64;
}
```

### BondingCurve

```typescript
interface BondingCurve {
  virtualTokenReserves: u64;
  virtualSolReserves: u64;
  realTokenReserves: u64;
  realSolReserves: u64;
  tokenTotalSupply: u64;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
}
```

**Size**: 150 bytes (after extension)

## PDA Derivations

### Bonding Curve
```typescript
seeds: ["bonding-curve", mint.toBuffer()]
```

### Associated Bonding Curve
```typescript
seeds: ["associated-bonding-curve", mint.toBuffer()]
```

### Creator Vault
```typescript
seeds: ["creator-vault", creator.toBuffer()]
```

### Global
```typescript
seeds: ["global"]
```

## Events

### CreateEvent
```typescript
{
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  user: PublicKey;
}
```

### TradeEvent
```typescript
{
  mint: PublicKey;
  solAmount: u64;
  tokenAmount: u64;
  isBuy: boolean;
  user: PublicKey;
  timestamp: i64;
  virtualSolReserves: u64;
  virtualTokenReserves: u64;
  realSolReserves: u64;
  realTokenReserves: u64;
}
```

### CompleteEvent
```typescript
{
  user: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  timestamp: i64;
}
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | NotAuthorized | Caller not authorized |
| 6001 | AlreadyInitialized | Already initialized |
| 6002 | TooMuchSolRequired | Slippage exceeded on buy |
| 6003 | TooLittleSolReceived | Slippage exceeded on sell |
| 6004 | MintDoesNotMatchBondingCurve | Wrong mint for bonding curve |
| 6005 | BondingCurveComplete | Curve already graduated |
| 6006 | BondingCurveNotComplete | Curve not ready to migrate |
| 6007 | NotInitialized | Not initialized |
| 6008 | InvalidAmount | Invalid amount |
