# Staking Examples

Complete examples for staking SOL and managing LSTs with Sanctum.

## Stake SOL for LST

### Basic Staking

```typescript
import { Connection, Keypair, Transaction } from '@solana/web3.js';

const SANCTUM_API = 'https://sanctum-api.ironforge.network';

interface StakeResult {
  signature: string;
  lstAmount: string;
  lstMint: string;
}

async function stakeSol(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  lstMint: string,
  solAmount: string, // In lamports
): Promise<StakeResult> {
  // 1. Get swap quote (SOL -> LST)
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', 'So11111111111111111111111111111111111111112');
  quoteUrl.searchParams.set('out', lstMint);
  quoteUrl.searchParams.set('amt', solAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  console.log(`Staking ${solAmount} lamports for ~${quote.outAmt} LST`);

  // 2. Sign transaction
  const txBuffer = Buffer.from(quote.tx, 'base64');
  const transaction = Transaction.from(txBuffer);
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

  const result = await executeResponse.json();

  return {
    signature: result.txSignature,
    lstAmount: quote.outAmt,
    lstMint,
  };
}

// Example: Stake 1 SOL for mSOL
const result = await stakeSol(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL mint
  '1000000000', // 1 SOL
);

console.log(`Staked! TX: ${result.signature}`);
console.log(`Received: ${result.lstAmount} mSOL`);
```

### Stake to Multiple LSTs

```typescript
const LST_ALLOCATIONS = {
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 0.4,    // 40% mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 0.3,   // 30% jitoSOL
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm': 0.3,   // 30% INF
};

async function stakeToMultipleLsts(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  totalSolAmount: bigint,
): Promise<StakeResult[]> {
  const results: StakeResult[] = [];

  for (const [lstMint, allocation] of Object.entries(LST_ALLOCATIONS)) {
    const amount = (totalSolAmount * BigInt(Math.floor(allocation * 100))) / 100n;

    const result = await stakeSol(
      apiKey,
      connection,
      signer,
      lstMint,
      amount.toString(),
    );

    results.push(result);

    // Small delay between transactions
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// Stake 10 SOL across multiple LSTs
const results = await stakeToMultipleLsts(
  API_KEY,
  connection,
  wallet,
  10_000_000_000n,
);
```

## Instant Unstake

### Unstake LST to SOL

```typescript
async function instantUnstake(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  lstMint: string,
  lstAmount: string,
): Promise<string> {
  // Get quote for LST -> SOL
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', lstMint);
  quoteUrl.searchParams.set('out', 'So11111111111111111111111111111111111111112');
  quoteUrl.searchParams.set('amt', lstAmount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer.publicKey.toBase58());
  quoteUrl.searchParams.set('slippageBps', '50');

  const quoteResponse = await fetch(quoteUrl.toString());
  const quote = await quoteResponse.json();

  console.log(`Unstaking ${lstAmount} LST for ~${quote.outAmt} lamports`);
  console.log(`Source: ${quote.source}`);

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
  return result.txSignature;
}

// Unstake 0.5 mSOL
const tx = await instantUnstake(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '500000000',
);
```

## Delayed Unstake (Lower Fees)

### Withdraw to Stake Account

```typescript
interface WithdrawStakeResult {
  signature: string;
  stakeAccount: string;
  lamports: string;
}

async function delayedUnstake(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  lstMint: string,
  amount: string,
  deactivate: boolean = true,
): Promise<WithdrawStakeResult> {
  // Get withdraw stake order
  const orderUrl = new URL(`${SANCTUM_API}/swap/withdrawStake/order`);
  orderUrl.searchParams.set('apiKey', apiKey);
  orderUrl.searchParams.set('lstMint', lstMint);
  orderUrl.searchParams.set('amount', amount);
  orderUrl.searchParams.set('signer', signer.publicKey.toBase58());
  orderUrl.searchParams.set('deactivate', deactivate.toString());

  const orderResponse = await fetch(orderUrl.toString());
  const order = await orderResponse.json();

  console.log(`Withdrawing to stake account: ${order.stakeAccount}`);
  console.log(`Expected lamports: ${order.lamports}`);

  // Sign and execute
  const txBuffer = Buffer.from(order.tx, 'base64');
  const transaction = Transaction.from(txBuffer);
  transaction.sign(signer);

  const executeResponse = await fetch(`${SANCTUM_API}/swap/withdrawStake/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: transaction.serialize().toString('base64'),
      orderResponse: order,
    }),
  });

  const result = await executeResponse.json();

  return {
    signature: result.txSignature,
    stakeAccount: order.stakeAccount,
    lamports: order.lamports,
  };
}

// Delayed unstake 1 mSOL
const result = await delayedUnstake(
  API_KEY,
  connection,
  wallet,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '1000000000',
  true, // Auto-deactivate
);

console.log(`Stake account created: ${result.stakeAccount}`);
console.log(`Will receive ${result.lamports} lamports after epoch ends`);
```

### Check Stake Account Status

```typescript
import { StakeProgram } from '@solana/web3.js';

async function checkStakeAccountStatus(
  connection: Connection,
  stakeAccountPubkey: string,
): Promise<{
  status: 'activating' | 'active' | 'deactivating' | 'inactive';
  lamports: bigint;
  activationEpoch?: number;
  deactivationEpoch?: number;
}> {
  const pubkey = new PublicKey(stakeAccountPubkey);
  const accountInfo = await connection.getAccountInfo(pubkey);

  if (!accountInfo) {
    throw new Error('Stake account not found');
  }

  const stakeAccount = StakeProgram.decodeDelegation(accountInfo.data);
  const epoch = await connection.getEpochInfo();

  let status: 'activating' | 'active' | 'deactivating' | 'inactive';

  if (stakeAccount.deactivationEpoch !== BigInt('0xffffffffffffffff')) {
    status = stakeAccount.deactivationEpoch <= epoch.epoch ? 'inactive' : 'deactivating';
  } else if (stakeAccount.activationEpoch >= epoch.epoch) {
    status = 'activating';
  } else {
    status = 'active';
  }

  return {
    status,
    lamports: BigInt(accountInfo.lamports),
    activationEpoch: Number(stakeAccount.activationEpoch),
    deactivationEpoch: stakeAccount.deactivationEpoch !== BigInt('0xffffffffffffffff')
      ? Number(stakeAccount.deactivationEpoch)
      : undefined,
  };
}
```

## Deposit Native Stake Account

### Convert Existing Stake to LST

```typescript
async function depositStakeForLst(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  stakeAccountPubkey: string,
  outputLstMint: string,
): Promise<{signature: string; lstAmount: string}> {
  // Get deposit order
  const orderUrl = new URL(`${SANCTUM_API}/swap/depositStake/order`);
  orderUrl.searchParams.set('apiKey', apiKey);
  orderUrl.searchParams.set('stakeAccount', stakeAccountPubkey);
  orderUrl.searchParams.set('outputLstMint', outputLstMint);
  orderUrl.searchParams.set('signer', signer.publicKey.toBase58());

  const orderResponse = await fetch(orderUrl.toString());
  const order = await orderResponse.json();

  console.log(`Converting stake account for ~${order.outAmt} LST`);

  // Sign and execute
  const txBuffer = Buffer.from(order.tx, 'base64');
  const transaction = Transaction.from(txBuffer);
  transaction.sign(signer);

  const executeResponse = await fetch(`${SANCTUM_API}/swap/depositStake/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: transaction.serialize().toString('base64'),
      orderResponse: order,
    }),
  });

  const result = await executeResponse.json();

  return {
    signature: result.txSignature,
    lstAmount: order.outAmt,
  };
}

// Convert native stake to jitoSOL
const result = await depositStakeForLst(
  API_KEY,
  connection,
  wallet,
  'StakeAccountPubkey...',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
);
```

## Staking Best Practices

### 1. Compare APYs Before Staking

```typescript
async function findBestLstApy(
  apiKey: string,
  lstMints: string[],
): Promise<{mint: string; symbol: string; apy: number}> {
  let best = { mint: '', symbol: '', apy: 0 };

  for (const mint of lstMints) {
    const response = await fetch(
      `${SANCTUM_API}/lsts/${mint}?apiKey=${apiKey}`
    );
    const lst = await response.json();

    if (lst.apy > best.apy) {
      best = { mint, symbol: lst.symbol, apy: lst.apy };
    }
  }

  return best;
}

// Find best APY among major LSTs
const best = await findBestLstApy(API_KEY, [
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

console.log(`Best APY: ${best.symbol} at ${best.apy}%`);
```

### 2. Use INF for Diversification

```typescript
// INF automatically diversifies across all LSTs in Infinity pool
async function stakeToInf(
  apiKey: string,
  connection: Connection,
  signer: Keypair,
  solAmount: string,
): Promise<string> {
  return stakeSol(
    apiKey,
    connection,
    signer,
    '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', // INF
    solAmount,
  ).then(r => r.signature);
}
```

### 3. Monitor Slippage

```typescript
async function getQuoteWithSlippageCheck(
  apiKey: string,
  inputMint: string,
  outputMint: string,
  amount: string,
  signer: string,
  maxSlippageBps: number = 100,
): Promise<{quote: any; acceptable: boolean}> {
  const quoteUrl = new URL(`${SANCTUM_API}/swap/token/order`);
  quoteUrl.searchParams.set('apiKey', apiKey);
  quoteUrl.searchParams.set('inp', inputMint);
  quoteUrl.searchParams.set('out', outputMint);
  quoteUrl.searchParams.set('amt', amount);
  quoteUrl.searchParams.set('mode', 'ExactIn');
  quoteUrl.searchParams.set('signer', signer);
  quoteUrl.searchParams.set('slippageBps', maxSlippageBps.toString());

  const response = await fetch(quoteUrl.toString());
  const quote = await response.json();

  const priceImpact = quote.priceImpactBps || 0;
  const acceptable = priceImpact <= maxSlippageBps;

  return { quote, acceptable };
}
```

## Fee Comparison

| Method | Fee | Time |
|--------|-----|------|
| Instant Unstake (Infinity) | 8-10 bps | Instant |
| Instant Unstake (Reserve) | ~1 bps | Instant |
| Delayed Unstake | 0 bps | 1-2 epochs (~4-8 days) |
| Deposit Stake | 10 bps | Instant |
