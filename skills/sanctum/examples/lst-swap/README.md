# LST Swap Examples

Complete examples for swapping between Liquid Staking Tokens using Sanctum.

## Basic LST Swap

### Swap One LST for Another

```typescript
import { Connection, Keypair, Transaction } from '@solana/web3.js';

const SANCTUM_API = 'https://sanctum-api.ironforge.network';

interface SwapQuote {
  tx: string;
  inpAmt: string;
  outAmt: string;
  source: string;
  feeAmt: string;
  feeMint: string;
  priceImpactBps?: number;
}

async function swapLst(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 50,
): Promise<{signature: string; outputAmount: string}> {
  // 1. Get swap quote
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', inputMint);
  quoteUrl.searchParams.set('out', outputMint);
  quoteUrl.searchParams.set('amt', amount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', slippageBps.toString());

  const quoteResponse = await fetch(quoteUrl.toString());

  if (!quoteResponse.ok) {
    throw new Error(`Quote failed: ${quoteResponse.status}`);
  }

  const quote: SwapQuote = await quoteResponse.json();

  console.log('Swap Quote:');
  console.log(`  Input: ${quote.inpAmt}`);
  console.log(`  Output: ${quote.outAmt}`);
  console.log(`  Source: ${quote.source}`);
  console.log(`  Fee: ${quote.feeAmt}`);

  // 2. Sign transaction
  const txBuffer = Buffer.from(quote.tx, 'base64');
  const transaction = Transaction.from(txBuffer);

  // Get fresh blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = signer.publicKey;

  transaction.sign(signer);

  // 3. Execute swap
  const executeResponse = await fetch(`${SANCTUM_API}/swap/token/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: transaction.serialize().toString('base64'),
      orderResponse: quote,
    }),
  });

  if (!executeResponse.ok) {
    const error = await executeResponse.text();
    throw new Error(`Execution failed: ${error}`);
  }

  const result = await executeResponse.json();

  return {
    signature: result.txSignature,
    outputAmount: quote.outAmt,
  };
}

// Example: Swap mSOL to jitoSOL
const result = await swapLst(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '1000000000', // 1 mSOL
);

console.log(`Swapped! TX: ${result.signature}`);
console.log(`Received: ${result.outputAmount} jitoSOL`);
```

## ExactOut Swap

### Specify Output Amount

```typescript
async function swapLstExactOut(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  inputMint: string,
  outputMint: string,
  outputAmount: string,
  slippageBps: number = 50,
): Promise<{signature: string; inputAmount: string}> {
  // Note: Not all swap sources support ExactOut
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', inputMint);
  quoteUrl.searchParams.set('out', outputMint);
  quoteUrl.searchParams.set('amt', outputAmount);
  quoteUrl.searchParams.set('mode', 'ExactOut');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', slippageBps.toString());

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote: SwapQuote = await quoteResponse.json();

  console.log(`Need ${quote.inpAmt} input for ${quote.outAmt} output`);

  // Sign and execute
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
    inputAmount: quote.inpAmt,
  };
}

// Get exactly 1 jitoSOL from mSOL
const result = await swapLstExactOut(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '1000000000', // Exactly 1 jitoSOL
);
```

## Multi-Hop Swaps

### Swap Through INF

```typescript
// Some swaps might route through INF for better rates
async function swapViaInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<{signature: string; outputAmount: string}> {
  // The API automatically finds the best route
  // which may include INF as an intermediate
  return swapLst(
    apiKey,
    connection,
    signer,
    inputMint,
    outputMint,
    amount,
    100, // Higher slippage for multi-hop
  );
}
```

## Quote Comparison

### Get Best Quote

```typescript
interface QuoteComparison {
  directQuote?: SwapQuote;
  viaInfQuote?: SwapQuote;
  bestRoute: 'direct' | 'via_inf';
  bestOutput: string;
}

async function compareQuotes(
  apiKey: string,
  inputMint: string,
  outputMint: string,
  amount: string,
  signer: string,
): Promise<QuoteComparison> {
  const INF_MINT = '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm';

  // Get direct quote
  let directQuote: SwapQuote | undefined;
  try {
    const directUrl = new URL(`${SANCTUM_API}/swap/token/order`);
    directUrl.searchParams.set('apiKey', apiKey);
    directUrl.searchParams.set('inp', inputMint);
    directUrl.searchParams.set('out', outputMint);
    directUrl.searchParams.set('amt', amount);
    directUrl.searchParams.set('mode', 'ExactIn');
    directUrl.searchParams.set('signer', signer);

    const response = await fetch(directUrl.toString());
    directQuote = await response.json();
  } catch {}

  // Get quote via INF (two hops)
  let viaInfQuote: SwapQuote | undefined;
  try {
    // First hop: input -> INF
    const hop1Url = new URL(`${SANCTUM_API}/swap/token/order`);
    hop1Url.searchParams.set('apiKey', apiKey);
    hop1Url.searchParams.set('inp', inputMint);
    hop1Url.searchParams.set('out', INF_MINT);
    hop1Url.searchParams.set('amt', amount);
    hop1Url.searchParams.set('mode', 'ExactIn');
    hop1Url.searchParams.set('signer', signer);

    const hop1Response = await fetch(hop1Url.toString());
    const hop1Quote = await hop1Response.json();

    // Second hop: INF -> output
    const hop2Url = new URL(`${SANCTUM_API}/swap/token/order`);
    hop2Url.searchParams.set('apiKey', apiKey);
    hop2Url.searchParams.set('inp', INF_MINT);
    hop2Url.searchParams.set('out', outputMint);
    hop2Url.searchParams.set('amt', hop1Quote.outAmt);
    hop2Url.searchParams.set('mode', 'ExactIn');
    hop2Url.searchParams.set('signer', signer);

    const hop2Response = await fetch(hop2Url.toString());
    const hop2Quote = await hop2Response.json();

    viaInfQuote = {
      ...hop2Quote,
      inpAmt: amount,
      outAmt: hop2Quote.outAmt,
      source: 'via_inf',
    };
  } catch {}

  // Compare outputs
  const directOutput = BigInt(directQuote?.outAmt || '0');
  const viaInfOutput = BigInt(viaInfQuote?.outAmt || '0');

  return {
    directQuote,
    viaInfQuote,
    bestRoute: directOutput >= viaInfOutput ? 'direct' : 'via_inf',
    bestOutput: (directOutput >= viaInfOutput ? directOutput : viaInfOutput).toString(),
  };
}
```

## Batch Swaps

### Execute Multiple Swaps

```typescript
interface BatchSwapParams {
  inputMint: string;
  outputMint: string;
  amount: string;
}

async function batchSwaps(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  swaps: BatchSwapParams[],
): Promise<string[]> {
  const signatures: string[] = [];

  for (const swap of swaps) {
    try {
      const result = await swapLst(
        apiKey,
        connection,
        signer,
        swap.inputMint,
        swap.outputMint,
        swap.amount,
      );
      signatures.push(result.signature);

      // Rate limit protection
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error(`Swap failed: ${error}`);
      signatures.push('FAILED');
    }
  }

  return signatures;
}

// Rebalance portfolio
const swaps: BatchSwapParams[] = [
  {
    inputMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    outputMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    amount: '500000000',
  },
  {
    inputMint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    outputMint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
    amount: '300000000',
  },
];

const results = await batchSwaps(API_KEY, connection, wallet, swaps);
```

## Price Impact Check

### Validate Swap Before Execution

```typescript
interface SwapValidation {
  isValid: boolean;
  priceImpactBps: number;
  effectiveRate: number;
  warnings: string[];
}

async function validateSwap(
  apiKey: string,
  inputMint: string,
  outputMint: string,
  amount: string,
  signer: string,
  maxPriceImpactBps: number = 100,
): Promise<SwapValidation> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', inputMint);
  quoteUrl.searchParams.set('out', outputMint);
  quoteUrl.searchParams.set('amt', amount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer);

  const response = await fetch(quoteUrl.toString());
  const quote: SwapQuote = await response.json();

  const priceImpactBps = quote.priceImpactBps || 0;
  const effectiveRate = Number(quote.outAmt) / Number(quote.inpAmt);

  const warnings: string[] = [];

  if (priceImpactBps > maxPriceImpactBps) {
    warnings.push(`High price impact: ${priceImpactBps} bps`);
  }

  if (priceImpactBps > 500) {
    warnings.push('CRITICAL: Price impact over 5%');
  }

  return {
    isValid: priceImpactBps <= maxPriceImpactBps,
    priceImpactBps,
    effectiveRate,
    warnings,
  };
}

// Check before swapping
const validation = await validateSwap(
  API_KEY,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '10000000000', // 10 mSOL
  wallet.publicKey.toBase58(),
);

if (!validation.isValid) {
  console.warn('Swap not recommended:', validation.warnings);
}
```

## Jupiter Integration

### Use Jupiter for Routing

```typescript
import { Jupiter } from '@jup-ag/core';

// Jupiter automatically includes Sanctum routes
async function swapViaJupiter(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<string> {
  const jupiter = await Jupiter.load({
    connection,
    cluster: 'mainnet-beta',
    user: wallet.publicKey,
  });

  // Get routes (includes Sanctum)
  const routes = await jupiter.computeRoutes({
    inputMint: new PublicKey(inputMint),
    outputMint: new PublicKey(outputMint),
    amount,
    slippageBps: 50,
  });

  if (routes.routesInfos.length === 0) {
    throw new Error('No routes found');
  }

  // Execute best route
  const { execute } = await jupiter.exchange({
    routeInfo: routes.routesInfos[0],
  });

  const result = await execute();
  return result.txid;
}
```

## Common Swap Pairs

| From | To | Typical Use Case |
|------|-------|-----------------|
| SOL | mSOL | Stake with Marinade |
| SOL | jitoSOL | Stake with MEV rewards |
| SOL | INF | Diversified yield |
| mSOL | jitoSOL | Switch protocols |
| mSOL | INF | Add to Infinity |
| jitoSOL | SOL | Instant unstake |
| INF | SOL | Exit Infinity |
| Any LST | INF | Consolidate to INF |

## Fee Reference

| Source | Swap Fee |
|--------|----------|
| Infinity Pool | 8 bps |
| Router | 0-10 bps |
| Reserve | ~1 bps |
| Withdraw (INF) | 10 bps |
