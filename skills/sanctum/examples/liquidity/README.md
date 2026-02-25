# Liquidity Management Examples

Complete examples for managing liquidity in Sanctum protocols.

## Overview

Sanctum offers multiple liquidity venues:
- **Infinity Pool**: Multi-LST liquidity pool (INF token)
- **Reserve**: Instant SOL liquidity for withdrawals
- **Router**: Stake account routing between pools

## Add Liquidity to Infinity

### Basic Liquidity Addition

```typescript
import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

const SANCTUM_API = 'https://sanctum-api.ironforge.network';
const INF_MINT = '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface LiquidityResult {
  signature: string;
  inputAmount: string;
  infReceived: string;
  shareOfPool: number;
}

async function addLiquidity(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  inputMint: string,
  amount: string,
): Promise<LiquidityResult> {
  // Get quote for adding liquidity
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', inputMint);
  quoteUrl.searchParams.set('out', INF_MINT);
  quoteUrl.searchParams.set('amt', amount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  // Sign transaction
  const txBuffer = Buffer.from(quote.tx, 'base64');
  const transaction = Transaction.from(txBuffer);
  transaction.sign(signer);

  // Execute
  const executeResponse = await fetch(`${SANCTUM_API}/swap/token/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: transaction.serialize().toString('base64'),
      orderResponse: quote,
    }),
  });

  const result = await executeResponse.json();

  // Get pool info for share calculation
  const infData = await fetch(`${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`);
  const infInfo = await infData.json();
  const shareOfPool = (Number(quote.outAmt) / (infInfo.totalSupply || 1e15)) * 100;

  return {
    signature: result.txSignature,
    inputAmount: amount,
    infReceived: quote.outAmt,
    shareOfPool,
  };
}

// Add 10 SOL as liquidity
const result = await addLiquidity(
  API_KEY,
  connection,
  wallet,
  SOL_MINT,
  '10000000000',
);

console.log(`Added liquidity! Received ${result.infReceived} INF`);
console.log(`Share of pool: ${result.shareOfPool.toFixed(6)}%`);
```

### Add Multiple LSTs as Liquidity

```typescript
interface MultiLiquidityResult {
  totalInfReceived: bigint;
  deposits: Array<{
    lstMint: string;
    amount: string;
    infReceived: string;
    signature: string;
  }>;
}

async function addMultipleLiquidity(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  deposits: Array<{lstMint: string; amount: string}>,
): Promise<MultiLiquidityResult> {
  const results: MultiLiquidityResult = {
    totalInfReceived: 0n,
    deposits: [],
  };

  for (const deposit of deposits) {
    const result = await addLiquidity(
      apiKey,
      connection,
      signer,
      deposit.lstMint,
      deposit.amount,
    );

    results.deposits.push({
      lstMint: deposit.lstMint,
      amount: deposit.amount,
      infReceived: result.infReceived,
      signature: result.signature,
    });

    results.totalInfReceived += BigInt(result.infReceived);

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// Add multiple LSTs
const multiResult = await addMultipleLiquidity(
  API_KEY,
  connection,
  wallet,
  [
    { lstMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', amount: '1000000000' },
    { lstMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', amount: '500000000' },
  ],
);
```

## Remove Liquidity

### Basic Withdrawal

```typescript
interface WithdrawResult {
  signature: string;
  infBurned: string;
  outputAmount: string;
  outputMint: string;
}

async function removeLiquidity(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  infAmount: string,
  outputMint: string,
): Promise<WithdrawResult> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', INF_MINT);
  quoteUrl.searchParams.set('out', outputMint);
  quoteUrl.searchParams.set('amt', infAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  // 10 bps withdrawal fee applies
  console.log(`Withdrawal fee: ~${Number(quote.feeAmt) / 1e9} SOL equivalent`);

  const txBuffer = Buffer.from(quote.tx, 'base64');
  const transaction = Transaction.from(txBuffer);
  transaction.sign(signer);

  const executeResponse = await fetch(`${SANCTUM_API}/swap/token/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: transaction.serialize().toString('base64'),
      orderResponse: quote,
    }),
  });

  const result = await executeResponse.json();

  return {
    signature: result.txSignature,
    infBurned: infAmount,
    outputAmount: quote.outAmt,
    outputMint,
  };
}

// Remove liquidity to SOL
const withdrawal = await removeLiquidity(
  API_KEY,
  connection,
  wallet,
  '5000000000', // 5 INF
  SOL_MINT,
);
```

### Withdraw to Multiple LSTs

```typescript
async function withdrawToMultiple(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  totalInfAmount: bigint,
  allocations: Array<{lstMint: string; percentage: number}>,
): Promise<WithdrawResult[]> {
  const results: WithdrawResult[] = [];

  for (const alloc of allocations) {
    const amount = (totalInfAmount * BigInt(Math.floor(alloc.percentage))) / 100n;

    const result = await removeLiquidity(
      apiKey,
      connection,
      signer,
      amount.toString(),
      alloc.lstMint,
    );

    results.push(result);
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// Withdraw 10 INF: 50% SOL, 30% mSOL, 20% jitoSOL
const withdrawals = await withdrawToMultiple(
  API_KEY,
  connection,
  wallet,
  10_000_000_000n,
  [
    { lstMint: SOL_MINT, percentage: 50 },
    { lstMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', percentage: 30 },
    { lstMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', percentage: 20 },
  ],
);
```

## Track Liquidity Position

### Get Current Position

```typescript
interface LiquidityPosition {
  infBalance: bigint;
  solValue: bigint;
  shareOfPool: number;
  earnedYield: bigint;
  currentApy: number;
}

async function getLiquidityPosition(
  apiKey: string,
  connection: Connection,
  wallet: PublicKey,
): Promise<LiquidityPosition> {
  // Get INF balance
  const infAta = await getAssociatedTokenAddress(
    new PublicKey(INF_MINT),
    wallet,
  );

  let infBalance = 0n;
  try {
    const account = await getAccount(connection, infAta);
    infBalance = account.amount;
  } catch {
    // No INF balance
  }

  // Get INF metadata
  const infResponse = await fetch(`${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`);
  const infInfo = await infResponse.json();

  // Calculate position
  const solValue = BigInt(
    Math.floor(Number(infBalance) * (infInfo.solValue || 1.0))
  );

  const shareOfPool = Number(infBalance) / (infInfo.totalSupply || 1e15) * 100;

  return {
    infBalance,
    solValue,
    shareOfPool,
    earnedYield: 0n, // Would need historical data
    currentApy: infInfo.apy,
  };
}

const position = await getLiquidityPosition(API_KEY, connection, wallet.publicKey);
console.log(`INF Balance: ${position.infBalance}`);
console.log(`SOL Value: ${position.solValue}`);
console.log(`Current APY: ${position.currentApy}%`);
```

### Track Yield Over Time

```typescript
interface YieldTracking {
  startDate: Date;
  startInfValue: number;
  currentInfValue: number;
  yieldEarned: number;
  annualizedReturn: number;
}

async function trackYield(
  apiKey: string,
  startInfValue: number,
  startDate: Date,
): Promise<YieldTracking> {
  // Get current INF value
  const response = await fetch(`${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`);
  const infInfo = await response.json();
  const currentInfValue = infInfo.solValue || 1.0;

  const yieldEarned = currentInfValue - startInfValue;
  const daysPassed = (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  const annualizedReturn = (yieldEarned / startInfValue) * (365 / daysPassed) * 100;

  return {
    startDate,
    startInfValue,
    currentInfValue,
    yieldEarned,
    annualizedReturn,
  };
}
```

## Liquidity Provider Strategies

### Dollar-Cost Averaging

```typescript
async function dcaIntoInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  dailyAmount: string, // Daily SOL amount
  days: number,
): Promise<void> {
  for (let i = 0; i < days; i++) {
    try {
      const result = await addLiquidity(
        apiKey,
        connection,
        signer,
        SOL_MINT,
        dailyAmount,
      );
      console.log(`Day ${i + 1}: Added ${dailyAmount} lamports, got ${result.infReceived} INF`);
    } catch (error) {
      console.error(`Day ${i + 1} failed:`, error);
    }

    // Wait for next day (in production, use proper scheduling)
    await new Promise(r => setTimeout(r, 24 * 60 * 60 * 1000));
  }
}
```

### Rebalancing Strategy

```typescript
async function rebalanceToInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  targetInfPercentage: number, // Target % of portfolio in INF
): Promise<void> {
  // Get all LST balances
  const lstMints = [
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  ];

  let totalValue = 0n;
  const balances: Map<string, bigint> = new Map();

  // Get INF balance
  const infAta = await getAssociatedTokenAddress(
    new PublicKey(INF_MINT),
    signer.publicKey,
  );
  try {
    const infAccount = await getAccount(connection, infAta);
    balances.set(INF_MINT, infAccount.amount);
    totalValue += infAccount.amount;
  } catch {}

  // Get other LST balances
  for (const mint of lstMints) {
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mint),
        signer.publicKey,
      );
      const account = await getAccount(connection, ata);
      balances.set(mint, account.amount);
      totalValue += account.amount;
    } catch {}
  }

  // Calculate current INF percentage
  const infBalance = balances.get(INF_MINT) || 0n;
  const currentInfPct = Number(infBalance) / Number(totalValue) * 100;

  console.log(`Current INF: ${currentInfPct.toFixed(2)}%, Target: ${targetInfPercentage}%`);

  if (currentInfPct < targetInfPercentage) {
    // Need to convert more LSTs to INF
    const targetInfValue = (BigInt(targetInfPercentage) * totalValue) / 100n;
    const needed = targetInfValue - infBalance;

    // Convert other LSTs proportionally
    for (const [mint, balance] of balances) {
      if (mint === INF_MINT) continue;
      if (balance === 0n) continue;

      const toConvert = (balance * needed) / (totalValue - infBalance);
      if (toConvert > 0n) {
        await addLiquidity(apiKey, connection, signer, mint, toConvert.toString());
      }
    }
  }
}
```

## Fee Analysis

### Calculate LP Returns

```typescript
interface LpReturns {
  stakingYield: number;
  tradingFees: number;
  totalApy: number;
  netAfterFees: number;
}

async function calculateLpReturns(apiKey: string): Promise<LpReturns> {
  const response = await fetch(`${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`);
  const infInfo = await response.json();

  // Estimate fee breakdown (actual may vary)
  const totalApy = infInfo.apy;
  const tradingFeePortion = 0.1; // ~10% from trading fees
  const stakingYield = totalApy * (1 - tradingFeePortion);
  const tradingFees = totalApy * tradingFeePortion;

  // Account for withdrawal fee on exit
  const withdrawalFee = 0.001; // 10 bps
  const netAfterFees = totalApy - (withdrawalFee * 100);

  return {
    stakingYield,
    tradingFees,
    totalApy,
    netAfterFees,
  };
}
```

## Best Practices

1. **Long-term Holding**: INF compounds over time - withdrawal fees favor longer holds
2. **Monitor APY**: Compare INF APY vs individual LSTs periodically
3. **Diversification**: INF provides automatic diversification across LSTs
4. **Gas Efficiency**: Batch deposits when possible to save on transaction fees
5. **Track Position**: Monitor your share of pool and earned yield
