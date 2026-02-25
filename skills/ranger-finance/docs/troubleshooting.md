# Troubleshooting Guide

Common issues and solutions when working with the Ranger Finance SDK.

## Common Issues

### API Errors

#### "Unauthorized" (Error 401)

**Problem**: API key is missing or invalid.

**Solutions**:

1. Verify your API key is set correctly:
```typescript
const client = new SorApi({
  apiKey: process.env.RANGER_API_KEY!, // Make sure this is set
});
```

2. Check your .env file:
```bash
RANGER_API_KEY=your_actual_api_key_here
```

3. Verify the API key format (should start with `sk_`)

---

#### "Rate limit exceeded" (Error 1005)

**Problem**: Too many API requests.

**Solutions**:

1. Add rate limiting to your code:
```typescript
async function withRateLimit<T>(
  operation: () => Promise<T>,
  delayMs: number = 1000
): Promise<T> {
  const result = await operation();
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return result;
}
```

2. Rate limits:
   - Standard: 100 requests/minute
   - Position queries: 30 requests/minute
   - Trade execution: 10 requests/minute

---

### Transaction Errors

#### "Transaction simulation failed"

**Problem**: Transaction would fail on-chain.

**Solutions**:

1. Simulate before sending:
```typescript
const transaction = decodeTransaction(txResponse.message);
const simulation = await connection.simulateTransaction(transaction);

if (simulation.value.err) {
  console.error('Simulation failed:', simulation.value.err);
  console.log('Logs:', simulation.value.logs);
}
```

2. Common causes:
   - Insufficient collateral
   - Position doesn't exist
   - Venue liquidity depleted

---

#### "Blockhash expired"

**Problem**: Transaction took too long to land.

**Solutions**:

1. Transactions from Ranger API have fresh blockhashes, but if you delay signing:
```typescript
// Don't delay between getting transaction and signing
const txResponse = await sorApi.increasePosition(request);
// Sign and send immediately
const signature = await executeTransaction(txResponse);
```

2. Use retry logic:
```typescript
async function executeWithRetry(
  getTransaction: () => Promise<TransactionResponse>,
  signAndSend: (tx: TransactionResponse) => Promise<string>,
  maxRetries: number = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = await getTransaction();
      return await signAndSend(tx);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Attempt ${i + 1} failed, retrying...`);
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

#### "Insufficient funds"

**Problem**: Not enough SOL for transaction fees or collateral.

**Solutions**:

1. Check balance before trading:
```typescript
const balance = await connection.getBalance(wallet.publicKey);
const MIN_SOL = 0.01 * 1e9; // 0.01 SOL for fees

if (balance < MIN_SOL) {
  throw new Error('Insufficient SOL for transaction fees');
}
```

2. Ensure you have enough collateral (USDC) in your wallet

---

### Position Errors

#### "Position not found" (Error 1002)

**Problem**: Trying to close/decrease a position that doesn't exist.

**Solutions**:

1. Fetch positions first:
```typescript
const positions = await sorApi.getPositions(walletAddress);
const hasPosition = positions.positions.some(
  p => p.symbol === 'SOL-PERP' && p.side === 'Long'
);

if (!hasPosition) {
  console.log('No position to close');
  return;
}
```

2. Verify you're using the correct symbol and side

---

#### "Insufficient liquidity" (Error 1004)

**Problem**: Not enough liquidity on venues for your order size.

**Solutions**:

1. Get a quote first to check liquidity:
```typescript
const quote = await sorApi.getOrderMetadata(request);

quote.venues.forEach(venue => {
  console.log(`${venue.venue_name} liquidity: ${venue.order_available_liquidity}`);
});
```

2. Reduce order size or split into smaller orders

---

### Wallet Issues

#### "Invalid keypair"

**Problem**: Private key format is incorrect.

**Solutions**:

1. Verify base58 format:
```typescript
import bs58 from 'bs58';

try {
  const privateKeyBytes = bs58.decode(process.env.WALLET_PRIVATE_KEY!);
  console.log('Key length:', privateKeyBytes.length); // Should be 64

  const keypair = Keypair.fromSecretKey(privateKeyBytes);
  console.log('Public key:', keypair.publicKey.toString());
} catch (error) {
  console.error('Invalid private key format');
}
```

2. If using a JSON keypair file:
```typescript
const secretKey = JSON.parse(fs.readFileSync('keypair.json', 'utf-8'));
const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
```

---

### Connection Issues

#### "Failed to connect to RPC"

**Problem**: Cannot reach Solana RPC endpoint.

**Solutions**:

1. Try a different RPC provider:
```typescript
// Public RPCs (rate limited)
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// Use a dedicated provider for production
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
```

2. Check network connectivity

3. Verify the RPC URL format

---

## Debugging Tips

### Enable Verbose Logging

```typescript
async function debugTrade(request: IncreasePositionRequest) {
  console.log('Request:', JSON.stringify(request, null, 2));

  try {
    const response = await sorApi.increasePosition(request);
    console.log('Response meta:', response.meta);
    console.log('Transaction length:', response.message.length);
    return response;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}
```

### Inspect Transaction Before Sending

```typescript
import { VersionedTransaction } from '@solana/web3.js';

function inspectTransaction(base64Message: string) {
  const buffer = Buffer.from(base64Message, 'base64');
  const tx = VersionedTransaction.deserialize(buffer);

  console.log('Transaction version:', tx.version);
  console.log('Signatures required:', tx.message.header.numRequiredSignatures);
  console.log('Account keys:', tx.message.staticAccountKeys.length);
}
```

### Check Position State

```typescript
async function debugPositions(walletAddress: string) {
  const positions = await sorApi.getPositions(walletAddress);

  console.log('Total positions:', positions.positions.length);

  positions.positions.forEach(pos => {
    console.log(`\n${pos.symbol} ${pos.side}:`);
    console.log('  Size:', pos.quantity);
    console.log('  Entry:', pos.entry_price);
    console.log('  Liquidation:', pos.liquidation_price);
    console.log('  PnL:', pos.unrealized_pnl);
    console.log('  Platform:', pos.platform);
  });
}
```

---

## Environment Setup Checklist

1. [ ] Node.js 18+ installed
2. [ ] Dependencies installed: `npm install @solana/web3.js bs58 dotenv`
3. [ ] `.env` file created with:
   - [ ] `RANGER_API_KEY` set
   - [ ] `SOLANA_RPC_URL` set (optional)
   - [ ] `WALLET_PRIVATE_KEY` set (for trading)
4. [ ] TypeScript configured (if using)
5. [ ] Wallet has SOL for fees
6. [ ] Wallet has USDC for collateral

---

## Getting Help

1. **Check the SKILL.md** - Main documentation with examples
2. **Review examples/** - Working code samples
3. **Check resources/** - API reference and types
4. **GitHub Issues** - https://github.com/ranger-finance
