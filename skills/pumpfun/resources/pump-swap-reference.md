# PumpSwap AMM API Reference

Complete API reference for the PumpSwap constant-product AMM program.

## Program Information

- **Program ID**: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- **GlobalConfig Address**: `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`
- **Network**: Mainnet & Devnet

## Instructions

### create_pool

Create a new liquidity pool.

```typescript
interface CreatePoolArgs {
  index: u16;              // Pool index for creator
  initialBaseAmount: u64;  // Initial base token amount
  initialQuoteAmount: u64; // Initial quote token amount
}
```

**Accounts**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | pool | Yes | No | Pool PDA |
| 1 | globalConfig | No | No | Global config |
| 2 | creator | Yes | Yes | Pool creator |
| 3 | baseMint | No | No | Base token mint |
| 4 | quoteMint | No | No | Quote token mint (usually WSOL) |
| 5 | lpMint | Yes | No | LP token mint PDA |
| 6 | creatorBaseAta | Yes | No | Creator base token account |
| 7 | creatorQuoteAta | Yes | No | Creator quote token account |
| 8 | creatorLpAta | Yes | No | Creator LP token account |
| 9 | poolBaseAccount | Yes | No | Pool base token account |
| 10 | poolQuoteAccount | Yes | No | Pool quote token account |
| 11 | tokenProgram | No | No | Token program |
| 12 | associatedTokenProgram | No | No | ATA program |
| 13 | systemProgram | No | No | System program |

### buy

Purchase base tokens with quote tokens.

```typescript
interface BuyArgs {
  baseAmountOut: u64;    // Base tokens to receive
  maxQuoteAmountIn: u64; // Max quote to spend (slippage)
}
```

### sell

Sell base tokens for quote tokens.

```typescript
interface SellArgs {
  baseAmountIn: u64;      // Base tokens to sell
  minQuoteAmountOut: u64; // Min quote to receive (slippage)
}
```

**Accounts for Buy/Sell (20)**:
| Index | Name | Writable | Signer | Description |
|-------|------|----------|--------|-------------|
| 0 | pool | Yes | No | Pool account |
| 1 | globalConfig | No | No | Global config |
| 2 | user | Yes | Yes | Trader |
| 3 | baseMint | No | No | Base token mint |
| 4 | quoteMint | No | No | Quote token mint |
| 5 | userBaseAta | Yes | No | User base token account |
| 6 | userQuoteAta | Yes | No | User quote token account |
| 7 | poolBaseAccount | Yes | No | Pool base account |
| 8 | poolQuoteAccount | Yes | No | Pool quote account |
| 9 | protocolFeeRecipient | Yes | No | Protocol fee recipient |
| 10 | protocolFeeRecipient2 | Yes | No | Protocol fee recipient 2 |
| 11-15 | protocolFeeRecipients | Yes | No | Additional fee recipients |
| 16 | tokenProgram | No | No | Token program |
| 17 | coinCreatorVaultAta | Yes | No | Creator vault token account |
| 18 | coinCreatorVaultAuthority | No | No | Creator vault authority PDA |
| 19 | feeProgram | No | No | Fee program |
| 20 | feeConfig | No | No | Fee config |

### deposit

Add liquidity to pool.

```typescript
interface DepositArgs {
  lpTokenAmount: u64;      // LP tokens to mint
  maxBaseAmount: u64;      // Max base to deposit
  maxQuoteAmount: u64;     // Max quote to deposit
}
```

### withdraw

Remove liquidity from pool.

```typescript
interface WithdrawArgs {
  lpTokenAmount: u64;      // LP tokens to burn
  minBaseAmount: u64;      // Min base to receive
  minQuoteAmount: u64;     // Min quote to receive
}
```

### collect_coin_creator_fee

Collect accumulated creator fees.

### extend_account

Extend pool account size for breaking changes.

**Use when**: Pool account size < 300 bytes

## Account Structures

### GlobalConfig

```typescript
interface GlobalConfig {
  admin: PublicKey;
  lpFeeBasisPoints: u16;           // 20 (0.2%)
  protocolFeeBasisPoints: u16;     // 5 (0.05%)
  coinCreatorFeeBasisPoints: u16;  // Creator fee
  disableFlags: u8;                // Operation flags
  protocolFeeRecipients: PublicKey[8]; // 8 fee recipients
  tokenIncentivesEnabled: boolean;
}
```

### Pool

```typescript
interface Pool {
  bump: u8;
  poolCreator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: u64;           // Original LP supply
  coinCreator: PublicKey;  // For fee distribution
  isMayhemMode: boolean;
}
```

**Size**: 300 bytes (after extension)

## PDA Derivations

### Pool
```typescript
const indexBuffer = Buffer.alloc(2);
indexBuffer.writeUInt16LE(index);

seeds: [
  "pool",
  indexBuffer,
  creator.toBuffer(),
  baseMint.toBuffer(),
  quoteMint.toBuffer()
]
```

### LP Mint
```typescript
seeds: ["pool_lp_mint", pool.toBuffer()]
```

### Pool Token Account
```typescript
seeds: ["pool_token_account", pool.toBuffer(), mint.toBuffer()]
```

### Creator Vault Authority
```typescript
seeds: ["creator_vault", coinCreator.toBuffer()]
```

## Swap Math

PumpSwap uses constant product formula:

```typescript
// For buying base tokens with quote
function calculateBuyOutput(
  quoteAmountIn: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  lpFeeBps: number,
  protocolFeeBps: number,
  creatorFeeBps: number
): bigint {
  const totalFeeBps = lpFeeBps + protocolFeeBps + creatorFeeBps;
  const feeMultiplier = 10000n - BigInt(totalFeeBps);
  const amountInAfterFee = (quoteAmountIn * feeMultiplier) / 10000n;

  // x * y = k
  // (quoteReserve + amountIn) * (baseReserve - amountOut) = k
  const baseAmountOut = (amountInAfterFee * baseReserve) /
                        (quoteReserve + amountInAfterFee);

  return baseAmountOut;
}

// For selling base tokens for quote
function calculateSellOutput(
  baseAmountIn: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  lpFeeBps: number,
  protocolFeeBps: number,
  creatorFeeBps: number
): bigint {
  const quoteAmountOut = (baseAmountIn * quoteReserve) /
                         (baseReserve + baseAmountIn);

  const totalFeeBps = lpFeeBps + protocolFeeBps + creatorFeeBps;
  const feeMultiplier = 10000n - BigInt(totalFeeBps);
  const amountOutAfterFee = (quoteAmountOut * feeMultiplier) / 10000n;

  return amountOutAfterFee;
}
```

## Events

### PoolCreatedEvent
```typescript
{
  pool: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAmount: u64;
  quoteAmount: u64;
}
```

### SwapEvent
```typescript
{
  pool: PublicKey;
  user: PublicKey;
  baseAmountIn: u64;
  quoteAmountIn: u64;
  baseAmountOut: u64;
  quoteAmountOut: u64;
}
```

### DepositEvent
```typescript
{
  pool: PublicKey;
  user: PublicKey;
  baseAmount: u64;
  quoteAmount: u64;
  lpTokens: u64;
}
```

### WithdrawEvent
```typescript
{
  pool: PublicKey;
  user: PublicKey;
  baseAmount: u64;
  quoteAmount: u64;
  lpTokens: u64;
}
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | SlippageExceeded | Output below minimum |
| 6001 | InsufficientLiquidity | Not enough liquidity |
| 6002 | InvalidPool | Pool doesn't exist |
| 6003 | PoolDisabled | Operations disabled |
| 6004 | InvalidMint | Wrong token mint |
| 6005 | MathOverflow | Calculation overflow |
| 6006 | ZeroAmount | Amount cannot be zero |
