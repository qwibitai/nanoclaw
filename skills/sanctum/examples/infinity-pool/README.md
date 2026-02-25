# Infinity Pool Examples

Complete examples for interacting with Sanctum's Infinity multi-LST liquidity pool.

## Understanding INF

INF is the token representing your share of the Infinity pool:
- **Reward-bearing**: Value increases vs SOL (not rebasing)
- **Diversified yield**: Earns weighted average of all LST yields
- **Trading fees**: Earns portion of swap fees from Infinity
- **No lockups**: Swap in/out anytime

## Get INF (Add Liquidity)

### Deposit SOL for INF

```typescript
import { Connection, Keypair, Transaction } from '@solana/web3.js';

const SANCTUM_API = 'https://sanctum-api.ironforge.network';
const INF_MINT = '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function depositSolForInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  solAmount: string, // In lamports
): Promise<{signature: string; infAmount: string}> {
  // Get quote
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', SOL_MINT);
  quoteUrl.searchParams.set('out', INF_MINT);
  quoteUrl.searchParams.set('amt', solAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  console.log(`Depositing ${solAmount} lamports for ~${quote.outAmt} INF`);

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
    infAmount: quote.outAmt,
  };
}

// Deposit 5 SOL
const result = await depositSolForInf(
  API_KEY,
  connection,
  wallet,
  '5000000000',
);

console.log(`Received ${result.infAmount} INF`);
```

### Deposit Any LST for INF

```typescript
async function depositLstForInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  lstMint: string,
  lstAmount: string,
): Promise<{signature: string; infAmount: string}> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', lstMint);
  quoteUrl.searchParams.set('out', INF_MINT);
  quoteUrl.searchParams.set('amt', lstAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

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
    infAmount: quote.outAmt,
  };
}

// Deposit 2 mSOL for INF
const result = await depositLstForInf(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '2000000000',
);
```

## Withdraw from INF (Remove Liquidity)

### Withdraw to SOL

```typescript
async function withdrawInfToSol(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  infAmount: string,
): Promise<{signature: string; solAmount: string}> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', INF_MINT);
  quoteUrl.searchParams.set('out', SOL_MINT);
  quoteUrl.searchParams.set('amt', infAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  // Note: 10 bps withdrawal fee
  console.log(`Withdrawing ${infAmount} INF for ~${quote.outAmt} SOL`);

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
    solAmount: quote.outAmt,
  };
}
```

### Withdraw to Specific LST

```typescript
async function withdrawInfToLst(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  infAmount: string,
  outputLstMint: string,
): Promise<{signature: string; lstAmount: string}> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', INF_MINT);
  quoteUrl.searchParams.set('out', outputLstMint);
  quoteUrl.searchParams.set('amt', infAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

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
    lstAmount: quote.outAmt,
  };
}

// Withdraw INF to jitoSOL
const result = await withdrawInfToLst(
  API_KEY,
  connection,
  wallet,
  '1000000000', // 1 INF
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
);
```

## Track INF Value

### Get Current INF/SOL Rate

```typescript
async function getInfSolRate(apiKey: string): Promise<number> {
  const response = await fetch(
    `${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`
  );
  const inf = await response.json();

  // INF metadata includes effective SOL value
  // Rate = how much SOL 1 INF is worth
  return inf.solValue || 1.0;
}

// Track INF value over time
async function trackInfValue(
  apiKey: string,
  infBalance: bigint,
): Promise<{infBalance: bigint; solValue: bigint; rate: number}> {
  const rate = await getInfSolRate(apiKey);
  const solValue = BigInt(Math.floor(Number(infBalance) * rate));

  return {
    infBalance,
    solValue,
    rate,
  };
}
```

### Get INF APY

```typescript
async function getInfApy(apiKey: string): Promise<{
  apy: number;
  stakingYield: number;
  tradingFees: number;
}> {
  const response = await fetch(
    `${SANCTUM_API}/lsts/INF?apiKey=${apiKey}`
  );
  const inf = await response.json();

  // INF APY = weighted LST yields + trading fees
  return {
    apy: inf.apy,
    stakingYield: inf.stakingYield || inf.apy * 0.9, // Estimate
    tradingFees: inf.tradingFees || inf.apy * 0.1,   // Estimate
  };
}
```

### Historical INF Performance

```typescript
async function getInfApyHistory(
  apiKey: string,
  epochs: number = 30,
): Promise<Array<{epoch: number; apy: number}>> {
  const response = await fetch(
    `${SANCTUM_API}/lsts/INF/apys?apiKey=${apiKey}&limit=${epochs}`
  );
  const data = await response.json();
  return data.apys;
}

// Calculate average APY
const history = await getInfApyHistory(API_KEY, 30);
const avgApy = history.reduce((sum, h) => sum + h.apy, 0) / history.length;
console.log(`30-epoch average APY: ${avgApy.toFixed(2)}%`);
```

## Infinity Pool Composition

### Get Pool Holdings

```typescript
interface PoolComposition {
  totalSolValue: number;
  holdings: Array<{
    lstMint: string;
    symbol: string;
    amount: bigint;
    solValue: number;
    percentage: number;
  }>;
}

async function getPoolComposition(apiKey: string): Promise<PoolComposition> {
  // This would require on-chain data or additional API
  // Simplified example using LST metadata
  const response = await fetch(`${SANCTUM_API}/lsts?apiKey=${apiKey}`);
  const lsts = await response.json();

  // Filter LSTs in Infinity pool
  const poolLsts = lsts.filter((lst: any) => lst.inInfinityPool);

  const totalSolValue = poolLsts.reduce(
    (sum: number, lst: any) => sum + lst.tvl,
    0
  );

  const holdings = poolLsts.map((lst: any) => ({
    lstMint: lst.mint,
    symbol: lst.symbol,
    amount: BigInt(lst.poolBalance || 0),
    solValue: lst.tvl,
    percentage: (lst.tvl / totalSolValue) * 100,
  }));

  return { totalSolValue, holdings };
}
```

## Automated INF Strategy

### Auto-Compound LSTs to INF

```typescript
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

const LST_MINTS = [
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
];

async function consolidateToInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  minAmountLamports: bigint = 100_000_000n, // 0.1 SOL minimum
): Promise<string[]> {
  const signatures: string[] = [];

  for (const lstMint of LST_MINTS) {
    try {
      // Check balance
      const ata = await getAssociatedTokenAddress(
        new PublicKey(lstMint),
        signer.publicKey
      );

      let balance: bigint;
      try {
        const account = await getAccount(connection, ata);
        balance = account.amount;
      } catch {
        continue; // No account
      }

      if (balance < minAmountLamports) {
        continue; // Below threshold
      }

      // Swap to INF
      const result = await depositLstForInf(
        apiKey,
        connection,
        signer,
        lstMint,
        balance.toString(),
      );

      signatures.push(result.signature);
      console.log(`Consolidated ${balance} ${lstMint} to INF`);

      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error(`Failed to consolidate ${lstMint}:`, error);
    }
  }

  return signatures;
}
```

## Fee Structure

| Operation | Fee |
|-----------|-----|
| Deposit SOL/LST to INF | 8 bps (swap fee) |
| Withdraw INF to SOL/LST | 10 bps (withdrawal fee) |
| Swap via Infinity | 8 bps |

**Fee Distribution:**
- 90% to INF holders (pool reserves)
- 10% to Sanctum protocol

## INF vs Individual LSTs

| Factor | INF | Individual LST |
|--------|-----|----------------|
| Diversification | All LSTs | Single protocol |
| Yield | Weighted avg + fees | Single protocol APY |
| Risk | Distributed | Protocol-specific |
| Liquidity | High (shared pool) | Varies |
| Complexity | Simple (hold INF) | Manage multiple |

## Best Practices

1. **Hold for Yield**: INF accrues value over time - no action needed
2. **Check Rates**: Compare INF APY vs individual LSTs
3. **Mind Fees**: 10 bps withdrawal fee - factor into decisions
4. **Diversification**: INF provides natural diversification
5. **Long-term**: Best for long-term staking due to compound effect
