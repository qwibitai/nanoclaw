# Orca Whirlpools API Reference

Complete reference for the `@orca-so/whirlpools` SDK functions and types.

## SDK Packages

| Package | Description |
|---------|-------------|
| `@orca-so/whirlpools` | High-level SDK (Web3.js v2) |
| `@orca-so/whirlpools-sdk` | Legacy SDK (Web3.js v1) |
| `@orca-so/whirlpools-core` | Math, quoting, and utility functions |
| `@orca-so/whirlpools-client` | Low-level auto-generated client |

---

## Configuration Functions

### setWhirlpoolsConfig

Configure the SDK for a specific network.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| config | `string \| WhirlpoolsConfigInput` | Yes | Network preset or custom config |

**Presets:** `"solanaMainnet"`, `"solanaDevnet"`, `"eclipseMainnet"`, `"eclipseTestnet"`

**Example:**

```typescript
import { setWhirlpoolsConfig } from "@orca-so/whirlpools";

await setWhirlpoolsConfig("solanaMainnet");
```

---

### setRpc

Set the RPC endpoint for the SDK.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpcUrl | `string` | Yes | RPC endpoint URL |

**Example:**

```typescript
import { setRpc } from "@orca-so/whirlpools";

await setRpc("https://api.mainnet-beta.solana.com");
```

---

### setPayerFromBytes

Load a wallet from keypair bytes.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| bytes | `Uint8Array` | Yes | Keypair secret key bytes |

**Returns:** `Promise<KeyPairSigner>`

**Example:**

```typescript
import { setPayerFromBytes } from "@orca-so/whirlpools";

const keypairBytes = new Uint8Array(JSON.parse(fs.readFileSync("keypair.json", "utf8")));
const wallet = await setPayerFromBytes(keypairBytes);
```

---

### setPriorityFeeSetting

Configure priority fee strategy for transactions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| setting | `PriorityFeeSetting` | Yes | Priority fee configuration |

**PriorityFeeSetting Types:**

```typescript
// Dynamic fee based on recent network fees
{ type: "dynamic", percentile: number }

// Fixed fee amount
{ type: "fixed", microLamports: number }

// Disable priority fees
{ type: "none" }
```

**Example:**

```typescript
import { setPriorityFeeSetting } from "@orca-so/whirlpools";

await setPriorityFeeSetting({ type: "dynamic", percentile: 75 });
```

---

### setJitoTipSetting

Configure Jito MEV tips for transactions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| setting | `JitoTipSetting` | Yes | Jito tip configuration |

**Example:**

```typescript
import { setJitoTipSetting } from "@orca-so/whirlpools";

await setJitoTipSetting({ type: "dynamic", percentile: 50 });
```

---

### setDefaultSlippageToleranceBps

Set default slippage tolerance in basis points.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| bps | `number` | Yes | Slippage in basis points (100 = 1%) |

**Example:**

```typescript
import { setDefaultSlippageToleranceBps } from "@orca-so/whirlpools";

await setDefaultSlippageToleranceBps(100); // 1%
```

---

### setDefaultFunder

Set the default wallet for funding transactions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| funder | `KeyPairSigner` | Yes | Wallet signer |

**Example:**

```typescript
import { setDefaultFunder } from "@orca-so/whirlpools";

await setDefaultFunder(wallet);
```

---

### setNativeMintWrappingStrategy

Configure how native SOL is wrapped for transactions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| strategy | `"ata" \| "none"` | Yes | Wrapping strategy |

**Example:**

```typescript
import { setNativeMintWrappingStrategy } from "@orca-so/whirlpools";

await setNativeMintWrappingStrategy("ata");
```

---

### resetConfiguration

Reset all SDK configuration to defaults.

**Example:**

```typescript
import { resetConfiguration } from "@orca-so/whirlpools";

await resetConfiguration();
```

---

## Swap Functions

### swapInstructions

Generate instructions for a token swap.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| params | `SwapParams` | Yes | Swap parameters |
| poolAddress | `Address` | Yes | Whirlpool address |
| slippageToleranceBps | `number` | No | Slippage in bps (default: 100) |
| signer | `TransactionSigner` | No | Wallet signer |

**SwapParams:**

```typescript
// Exact input swap
{ inputAmount: bigint, mint: Address }

// Exact output swap
{ outputAmount: bigint, mint: Address }
```

**Returns:** `Promise<SwapInstructions>`

```typescript
interface SwapInstructions {
  instructions: TransactionInstruction[];
  quote: SwapQuote;
  callback: () => Promise<string>; // Send transaction
}

interface SwapQuote {
  tokenIn: Address;
  tokenOut: Address;
  tokenEstIn: bigint;
  tokenEstOut: bigint;
  tokenMaxIn: bigint;
  tokenMinOut: bigint;
  priceImpact: number;
}
```

**Example:**

```typescript
import { swapInstructions } from "@orca-so/whirlpools";
import { address } from "@solana/kit";

const { instructions, quote } = await swapInstructions(
  rpc,
  { inputAmount: 1_000_000n, mint: address("INPUT_MINT") },
  address("POOL_ADDRESS"),
  100,
  wallet
);
```

---

### swap

Execute a token swap (builds and sends transaction).

**Parameters:** Same as `swapInstructions`

**Returns:** `Promise<string>` - Transaction signature

**Example:**

```typescript
import { swap } from "@orca-so/whirlpools";

const txId = await swap(
  rpc,
  { inputAmount: 1_000_000n, mint: inputMint },
  poolAddress,
  100,
  wallet
);
```

---

## Position Management Functions

### openPositionInstructions

Generate instructions to open a concentrated liquidity position.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| poolAddress | `Address` | Yes | Whirlpool address |
| param | `IncreaseLiquidityQuoteParam` | Yes | Liquidity amount |
| lowerPrice | `number` | Yes | Lower price bound |
| upperPrice | `number` | Yes | Upper price bound |
| slippageToleranceBps | `number` | No | Slippage in bps |
| signer | `TransactionSigner` | No | Wallet signer |

**IncreaseLiquidityQuoteParam:**

```typescript
{ tokenA: bigint } | { tokenB: bigint } | { liquidity: bigint }
```

**Returns:** `Promise<OpenPositionInstructions>`

```typescript
interface OpenPositionInstructions {
  instructions: TransactionInstruction[];
  quote: IncreaseLiquidityQuote;
  positionMint: Address;
  initializationCost: bigint;
  callback: () => Promise<string>;
}
```

**Example:**

```typescript
import { openPositionInstructions } from "@orca-so/whirlpools";

const { positionMint, quote } = await openPositionInstructions(
  rpc,
  poolAddress,
  { tokenA: 1_000_000_000n },
  0.001,
  100.0,
  100,
  wallet
);
```

---

### openFullRangePositionInstructions

Generate instructions to open a full-range position.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| poolAddress | `Address` | Yes | Whirlpool address |
| param | `IncreaseLiquidityQuoteParam` | Yes | Liquidity amount |
| slippageToleranceBps | `number` | No | Slippage in bps |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<OpenPositionInstructions>`

**Example:**

```typescript
import { openFullRangePositionInstructions } from "@orca-so/whirlpools";

const { positionMint, quote, callback } = await openFullRangePositionInstructions(
  rpc,
  poolAddress,
  { tokenA: 1_000_000_000n },
  100,
  wallet
);

const txId = await callback();
```

---

### increaseLiquidityInstructions

Generate instructions to add liquidity to an existing position.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| positionMint | `Address` | Yes | Position NFT mint |
| param | `IncreaseLiquidityQuoteParam` | Yes | Liquidity amount |
| slippageToleranceBps | `number` | No | Slippage in bps |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<IncreaseLiquidityInstructions>`

**Example:**

```typescript
import { increaseLiquidityInstructions } from "@orca-so/whirlpools";

const { instructions, quote } = await increaseLiquidityInstructions(
  rpc,
  positionMint,
  { tokenA: 500_000_000n },
  100,
  wallet
);
```

---

### decreaseLiquidityInstructions

Generate instructions to remove liquidity from a position.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| positionMint | `Address` | Yes | Position NFT mint |
| param | `DecreaseLiquidityQuoteParam` | Yes | Liquidity amount |
| slippageToleranceBps | `number` | No | Slippage in bps |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<DecreaseLiquidityInstructions>`

**Example:**

```typescript
import { decreaseLiquidityInstructions } from "@orca-so/whirlpools";

const { instructions, quote } = await decreaseLiquidityInstructions(
  rpc,
  positionMint,
  { liquidity: 1000000n },
  100,
  wallet
);
```

---

### harvestPositionInstructions

Generate instructions to collect fees and rewards from a position.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| positionMint | `Address` | Yes | Position NFT mint |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<HarvestPositionInstructions>`

```typescript
interface HarvestPositionInstructions {
  instructions: TransactionInstruction[];
  feesQuote: {
    feeOwedA: bigint;
    feeOwedB: bigint;
  };
  rewardsQuote: RewardQuote[];
  callback: () => Promise<string>;
}
```

**Example:**

```typescript
import { harvestPositionInstructions } from "@orca-so/whirlpools";

const { feesQuote, rewardsQuote } = await harvestPositionInstructions(
  rpc,
  positionMint,
  wallet
);
```

---

### closePositionInstructions

Generate instructions to close a position and withdraw all liquidity.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| positionMint | `Address` | Yes | Position NFT mint |
| slippageToleranceBps | `number` | No | Slippage in bps |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<ClosePositionInstructions>`

**Example:**

```typescript
import { closePositionInstructions } from "@orca-so/whirlpools";

const { instructions, quote, feesQuote } = await closePositionInstructions(
  rpc,
  positionMint,
  100,
  wallet
);
```

---

## Pool Functions

### createSplashPoolInstructions

Generate instructions to create a splash pool (full-range AMM).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| tokenMintA | `Address` | Yes | First token mint |
| tokenMintB | `Address` | Yes | Second token mint |
| initialPrice | `number` | Yes | Initial price (B per A) |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<CreatePoolInstructions>`

```typescript
interface CreatePoolInstructions {
  instructions: TransactionInstruction[];
  poolAddress: Address;
  initializationCost: bigint;
  callback: () => Promise<string>;
}
```

**Example:**

```typescript
import { createSplashPoolInstructions } from "@orca-so/whirlpools";

const { poolAddress, initializationCost } = await createSplashPoolInstructions(
  rpc,
  tokenMintA,
  tokenMintB,
  1.5,
  wallet
);
```

---

### createConcentratedLiquidityPoolInstructions

Generate instructions to create a concentrated liquidity pool.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| tokenMintA | `Address` | Yes | First token mint |
| tokenMintB | `Address` | Yes | Second token mint |
| tickSpacing | `number` | Yes | Tick spacing (1, 8, 64, 128) |
| initialPrice | `number` | Yes | Initial price (B per A) |
| signer | `TransactionSigner` | No | Wallet signer |

**Returns:** `Promise<CreatePoolInstructions>`

**Example:**

```typescript
import { createConcentratedLiquidityPoolInstructions } from "@orca-so/whirlpools";

const { poolAddress } = await createConcentratedLiquidityPoolInstructions(
  rpc,
  tokenMintA,
  tokenMintB,
  64,
  1.5,
  wallet
);
```

---

## Fetch Functions

### fetchPositionsForOwner

Fetch all positions owned by a wallet.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| owner | `Address` | Yes | Wallet address |

**Returns:** `Promise<HydratedPosition[]>`

```typescript
interface HydratedPosition {
  positionMint: Address;
  whirlpool: Address;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeOwedA: bigint;
  feeOwedB: bigint;
  rewardInfos: RewardInfo[];
}
```

**Example:**

```typescript
import { fetchPositionsForOwner } from "@orca-so/whirlpools";

const positions = await fetchPositionsForOwner(rpc, wallet.address);
```

---

### fetchPositionsInWhirlpool

Fetch all positions in a specific pool.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| poolAddress | `Address` | Yes | Whirlpool address |

**Returns:** `Promise<HydratedPosition[]>`

---

### fetchWhirlpoolsByTokenPair

Fetch all pools for a token pair.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| tokenMintA | `Address` | Yes | First token mint |
| tokenMintB | `Address` | Yes | Second token mint |

**Returns:** `Promise<PoolInfo[]>`

```typescript
interface PoolInfo {
  address: Address;
  tokenMintA: Address;
  tokenMintB: Address;
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
}
```

---

### fetchSplashPool

Fetch splash pool data.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| poolAddress | `Address` | Yes | Pool address |

**Returns:** `Promise<PoolInfo>`

---

### fetchConcentratedLiquidityPool

Fetch concentrated liquidity pool data.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rpc | `Rpc` | Yes | RPC client |
| poolAddress | `Address` | Yes | Pool address |

**Returns:** `Promise<PoolInfo>`

---

## Utility Functions

### orderMints

Order two mint addresses according to Whirlpool conventions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| mintA | `Address` | Yes | First mint |
| mintB | `Address` | Yes | Second mint |

**Returns:** `[Address, Address]` - Ordered mints

**Example:**

```typescript
import { orderMints } from "@orca-so/whirlpools";

const [orderedA, orderedB] = orderMints(mintA, mintB);
```

---

### getPayer

Get the currently configured payer wallet.

**Returns:** `KeyPairSigner | undefined`

**Example:**

```typescript
import { getPayer } from "@orca-so/whirlpools";

const payer = getPayer();
console.log("Payer:", payer?.address);
```

---

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | InvalidEnum | Invalid enum value |
| 6001 | InvalidStartTick | Start tick not divisible by tick spacing |
| 6002 | TickArrayExistInPool | Tick array already exists |
| 6003 | TickArrayIndexOutofBounds | Tick array index out of bounds |
| 6004 | InvalidTickSpacing | Invalid tick spacing |
| 6005 | ClosePositionNotEmpty | Cannot close position with liquidity |
| 6006 | DivideByZero | Division by zero |
| 6007 | NumberCastError | Number cast error |
| 6008 | NumberDownCastError | Number downcast error |
| 6009 | TickNotFound | Tick not found |
| 6010 | InvalidTickIndex | Invalid tick index |
| 6011 | SqrtPriceOutOfBounds | Sqrt price out of bounds |
| 6012 | LiquidityZero | Liquidity is zero |
| 6013 | LiquidityTooHigh | Liquidity too high |
| 6014 | LiquidityOverflow | Liquidity overflow |
| 6015 | LiquidityUnderflow | Liquidity underflow |
| 6016 | LiquidityNetError | Liquidity net error |
| 6017 | TokenMaxExceeded | Token max exceeded |
| 6018 | TokenMinSubceeded | Token min not met |
| 6019 | MissingOrInvalidDelegate | Missing or invalid delegate |
| 6020 | InvalidPositionTokenAmount | Invalid position token amount |
| 6021 | InvalidTimestampConversion | Invalid timestamp conversion |
| 6022 | InvalidTimestamp | Invalid timestamp |
| 6023 | InvalidTickArraySequence | Invalid tick array sequence |
| 6024 | InvalidTokenMintOrder | Token mints must be ordered |
| 6025 | RewardNotInitialized | Reward not initialized |
| 6026 | InvalidRewardIndex | Invalid reward index |
| 6027 | RewardVaultAmountInsufficient | Reward vault insufficient |
| 6028 | FeeRateMaxExceeded | Fee rate max exceeded |
| 6029 | ProtocolFeeRateMaxExceeded | Protocol fee rate max exceeded |
| 6030 | MultiplicationShiftRightOverflow | Multiplication overflow |
| 6031 | MulDivOverflow | MulDiv overflow |
| 6032 | MulDivInvalidInput | MulDiv invalid input |
| 6033 | MultiplicationOverflow | Multiplication overflow |
| 6034 | InvalidSqrtPriceLimitDirection | Invalid sqrt price limit direction |
| 6035 | ZeroTradableAmount | Zero tradable amount |
| 6036 | AmountOutBelowMinimum | Amount out below minimum |
| 6037 | AmountInAboveMaximum | Amount in above maximum |
| 6038 | TickArraySequenceInvalidIndex | Tick array sequence invalid index |
| 6039 | AmountCalcOverflow | Amount calc overflow |
| 6040 | AmountRemainingOverflow | Amount remaining overflow |
