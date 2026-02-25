# Sanctum Troubleshooting Guide

Common issues and solutions when integrating Sanctum.

## API Issues

### 401 Unauthenticated

**Error:** `401 Unauthenticated`

**Cause:** Missing or invalid API key.

**Solution:**
```typescript
// Always include apiKey in requests
const url = `https://sanctum-api.ironforge.network/lsts?apiKey=${API_KEY}`;

// Check API key is set
if (!API_KEY) {
  throw new Error('SANCTUM_API_KEY environment variable not set');
}
```

### 429 Rate Limited

**Error:** `429 Too Many Requests`

**Cause:** Exceeded API rate limits.

**Solution:**
```typescript
// Implement exponential backoff
async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`Rate limited, waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return response.json();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
    }
  }
}

// Cache LST metadata
const lstCache = new Map();
const CACHE_TTL = 60000; // 1 minute

async function getCachedLst(apiKey: string, mint: string): Promise<any> {
  const cached = lstCache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await fetch(`${SANCTUM_API}/lsts/${mint}?apiKey=${apiKey}`);
  lstCache.set(mint, { data: await data.json(), timestamp: Date.now() });
  return lstCache.get(mint).data;
}
```

### 400 Bad Request

**Error:** `400 Bad Request - Invalid parameters`

**Cause:** Missing or malformed parameters.

**Solution:**
```typescript
// Validate parameters before request
function validateSwapParams(params: {
  inp: string;
  out: string;
  amt: string;
  mode: string;
  signer: string;
}): void {
  if (!params.inp || params.inp.length !== 44) {
    throw new Error('Invalid input mint');
  }
  if (!params.out || params.out.length !== 44) {
    throw new Error('Invalid output mint');
  }
  if (!params.amt || BigInt(params.amt) <= 0n) {
    throw new Error('Invalid amount');
  }
  if (!['ExactIn', 'ExactOut'].includes(params.mode)) {
    throw new Error('Mode must be ExactIn or ExactOut');
  }
  if (!params.signer || params.signer.length !== 44) {
    throw new Error('Invalid signer');
  }
}
```

## Transaction Issues

### Transaction Too Large

**Error:** `Transaction too large`

**Cause:** Too many instructions or accounts.

**Solution:**
```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

// Add compute budget if needed
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400_000,
});

const tx = Transaction.from(Buffer.from(quote.tx, 'base64'));
tx.add(modifyComputeUnits);
```

### Blockhash Expired

**Error:** `Blockhash not found` or `Transaction expired`

**Cause:** Transaction took too long to submit.

**Solution:**
```typescript
// Get fresh blockhash before signing
const { blockhash, lastValidBlockHeight } =
  await connection.getLatestBlockhash('confirmed');

const tx = Transaction.from(Buffer.from(quote.tx, 'base64'));
tx.recentBlockhash = blockhash;
tx.feePayer = signer.publicKey;
tx.sign(signer);

// Confirm with timeout
const signature = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction({
  signature,
  blockhash,
  lastValidBlockHeight,
});
```

### Insufficient Funds

**Error:** `Insufficient funds for transaction`

**Cause:** Not enough SOL for fees or token balance too low.

**Solution:**
```typescript
// Check balance before swap
async function validateBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
  requiredAmount: bigint,
): Promise<boolean> {
  if (mint === 'So11111111111111111111111111111111111111112') {
    // SOL balance
    const balance = await connection.getBalance(wallet);
    // Need extra for tx fee
    return BigInt(balance) >= requiredAmount + 10_000_000n;
  } else {
    // Token balance
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet);
    try {
      const account = await getAccount(connection, ata);
      return account.amount >= requiredAmount;
    } catch {
      return false;
    }
  }
}
```

### Slippage Exceeded

**Error:** `Slippage tolerance exceeded`

**Cause:** Price moved between quote and execution.

**Solution:**
```typescript
// Use appropriate slippage
const SLIPPAGE_BPS = {
  stable: 10,    // SOL <-> LSTs
  normal: 50,    // Most swaps
  volatile: 100, // Large amounts or illiquid pairs
};

// Refresh quote if stale
async function getQuoteWithExpiry(
  apiKey: string,
  params: SwapParams,
  maxAgeMs: number = 30000,
): Promise<SwapQuote> {
  const quote = await getSwapQuote(apiKey, params);
  const quoteTime = Date.now();

  return {
    ...quote,
    isValid: () => Date.now() - quoteTime < maxAgeMs,
    refresh: () => getSwapQuote(apiKey, params),
  };
}
```

## LST-Specific Issues

### LST Not Found

**Error:** `LST not found` or `Invalid mint`

**Cause:** Mint address not in Sanctum's supported list.

**Solution:**
```typescript
// Verify LST is supported
async function isLstSupported(apiKey: string, mint: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${SANCTUM_API}/lsts/${mint}?apiKey=${apiKey}`
    );
    return response.ok;
  } catch {
    return false;
  }
}

// Get list of all supported LSTs
async function getSupportedLsts(apiKey: string): Promise<Set<string>> {
  const response = await fetch(`${SANCTUM_API}/lsts?apiKey=${apiKey}`);
  const lsts = await response.json();
  return new Set(lsts.map((lst: any) => lst.mint));
}
```

### ExactOut Not Supported

**Error:** `ExactOut mode not supported for this route`

**Cause:** Some swap sources don't support exact output mode.

**Solution:**
```typescript
// Fall back to ExactIn with buffer
async function swapWithFallback(
  apiKey: string,
  params: SwapParams,
): Promise<SwapQuote> {
  try {
    // Try ExactOut first
    return await getSwapQuote(apiKey, { ...params, mode: 'ExactOut' });
  } catch {
    // Fall back to ExactIn with 1% buffer
    const bufferedAmount = (BigInt(params.amt) * 101n) / 100n;
    return await getSwapQuote(apiKey, {
      ...params,
      mode: 'ExactIn',
      amt: bufferedAmount.toString(),
    });
  }
}
```

## Stake Account Issues

### Stake Account Not Active

**Error:** `Stake account not in active state`

**Cause:** Trying to deposit a deactivating or inactive stake account.

**Solution:**
```typescript
import { StakeProgram } from '@solana/web3.js';

async function validateStakeAccount(
  connection: Connection,
  stakeAccount: PublicKey,
): Promise<{valid: boolean; reason?: string}> {
  const info = await connection.getAccountInfo(stakeAccount);
  if (!info) {
    return { valid: false, reason: 'Account not found' };
  }

  const stake = StakeProgram.decodeDelegation(info.data);
  const epoch = await connection.getEpochInfo();

  // Check if active
  if (stake.deactivationEpoch !== BigInt('0xffffffffffffffff')) {
    return { valid: false, reason: 'Stake is deactivating' };
  }

  if (stake.activationEpoch >= epoch.epoch) {
    return { valid: false, reason: 'Stake still activating' };
  }

  return { valid: true };
}
```

### Stake Account Wrong Validator

**Error:** `Validator not supported by stake pool`

**Cause:** The stake account's validator isn't in the target pool's validator set.

**Solution:**
```typescript
// Check if stake account can be deposited to target LST
async function canDepositStake(
  apiKey: string,
  stakeAccount: string,
  lstMint: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${SANCTUM_API}/swap/depositStake/order?apiKey=${apiKey}&stakeAccount=${stakeAccount}&outputLstMint=${lstMint}&signer=11111111111111111111111111111111`
    );
    return response.ok;
  } catch {
    return false;
  }
}
```

## INF-Specific Issues

### INF Value Calculation

**Problem:** INF value seems incorrect.

**Solution:**
```typescript
// INF is reward-bearing, not rebasing
// 1 INF != 1 SOL
async function getAccurateInfValue(
  apiKey: string,
  infAmount: bigint,
): Promise<bigint> {
  const response = await fetch(`${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`);
  const infInfo = await response.json();

  // INF value increases over time
  const solPerInf = infInfo.solValue || 1.0;
  return BigInt(Math.floor(Number(infAmount) * solPerInf));
}
```

### Withdrawal Fee

**Problem:** Received less than expected when withdrawing INF.

**Explanation:**
```typescript
// Withdrawal fee is 10 bps (0.1%)
const WITHDRAWAL_FEE_BPS = 10;

function calculateWithdrawalOutput(
  infAmount: bigint,
  solPerInf: number,
): bigint {
  const grossSol = BigInt(Math.floor(Number(infAmount) * solPerInf));
  const fee = (grossSol * BigInt(WITHDRAWAL_FEE_BPS)) / 10000n;
  return grossSol - fee;
}
```

## Debugging Tips

### Enable Logging

```typescript
async function debugSwap(
  apiKey: string,
  params: SwapParams,
): Promise<void> {
  console.log('=== Swap Debug ===');
  console.log('Input:', params.inp);
  console.log('Output:', params.out);
  console.log('Amount:', params.amt);
  console.log('Mode:', params.mode);

  const quote = await getSwapQuote(apiKey, params);
  console.log('Quote received:');
  console.log('  Source:', quote.source);
  console.log('  Input:', quote.inpAmt);
  console.log('  Output:', quote.outAmt);
  console.log('  Fee:', quote.feeAmt);
  console.log('  Price Impact:', quote.priceImpactBps, 'bps');
}
```

### Transaction Inspection

```typescript
import { Transaction } from '@solana/web3.js';

function inspectTransaction(base64Tx: string): void {
  const tx = Transaction.from(Buffer.from(base64Tx, 'base64'));

  console.log('=== Transaction Details ===');
  console.log('Instructions:', tx.instructions.length);

  tx.instructions.forEach((ix, i) => {
    console.log(`Instruction ${i}:`);
    console.log('  Program:', ix.programId.toBase58());
    console.log('  Accounts:', ix.keys.length);
    console.log('  Data length:', ix.data.length);
  });
}
```

## Getting Help

1. **Sanctum Docs**: https://learn.sanctum.so/docs
2. **Discord**: https://discord.gg/sanctum
3. **Twitter**: @sanctumso

When reporting issues, include:
- API endpoint called
- Request parameters (redact API key)
- Full error message
- Transaction signature (if applicable)
