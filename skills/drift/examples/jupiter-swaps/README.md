# Jupiter Swap Integration Examples

## Setup Jupiter Client

```typescript
import { JupiterClient } from '@drift-labs/sdk';
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const jupiterClient = new JupiterClient({ connection });
```

## Get Quote (Preview)

```typescript
// Preview swap rate before executing
const quote = await jupiterClient.getQuote({
  inputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
  outputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
  amount: driftClient.convertToSpotPrecision(0, 100), // 100 USDC
  slippageBps: 50, // 0.5% slippage
});

console.log('Input amount:', quote.inAmount);
console.log('Output amount:', quote.outAmount);
console.log('Price impact:', quote.priceImpactPct);
```

## Execute Swap

### Basic Swap (USDC to SOL)

```typescript
// Swap 100 USDC to SOL
const txSig = await driftClient.swap({
  jupiterClient,
  inMarketIndex: 0,   // USDC (spot market index)
  outMarketIndex: 1,  // SOL (spot market index)
  amount: driftClient.convertToSpotPrecision(0, 100), // 100 USDC
  slippageBps: 50,    // 0.5% max slippage
});

console.log('Swap transaction:', txSig);
```

### Swap SOL to USDC

```typescript
const txSig = await driftClient.swap({
  jupiterClient,
  inMarketIndex: 1,   // SOL
  outMarketIndex: 0,  // USDC
  amount: driftClient.convertToSpotPrecision(1, 1), // 1 SOL
  slippageBps: 50,
});
```

### Swap with Direct Routes Only

```typescript
// Only use direct token pairs (no multi-hop)
const txSig = await driftClient.swap({
  jupiterClient,
  inMarketIndex: 0,
  outMarketIndex: 1,
  amount: driftClient.convertToSpotPrecision(0, 100),
  slippageBps: 50,
  onlyDirectRoutes: true, // Faster but may have worse rate
});
```

### Swap with Custom Compute Budget

```typescript
const txSig = await driftClient.swap({
  jupiterClient,
  inMarketIndex: 0,
  outMarketIndex: 1,
  amount: driftClient.convertToSpotPrecision(0, 100),
  slippageBps: 50,
  computeUnits: 400000, // Custom compute units
  prioritizationFeeMicroLamports: 1000, // Priority fee
});
```

## Get Swap Instructions (For Custom Transactions)

```typescript
// Get instructions without executing
const swapIxs = await driftClient.getJupiterSwapIx({
  jupiterClient,
  inMarketIndex: 0,
  outMarketIndex: 1,
  amount: driftClient.convertToSpotPrecision(0, 100),
  slippageBps: 50,
});

// Add to custom transaction
const tx = new Transaction();
for (const ix of swapIxs) {
  tx.add(ix);
}

// Add other instructions...
// tx.add(otherInstruction);

// Send
await driftClient.sendTransaction(tx);
```

## Available Spot Markets for Swaps

| Market Index | Token | Mint Address |
|--------------|-------|--------------|
| 0 | USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v |
| 1 | SOL | So11111111111111111111111111111111111111112 |
| 2 | mSOL | mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So |
| 3 | wBTC | 3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh |
| 4 | wETH | 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs |
| ... | ... | Check getSpotMarketAccounts() |

## Calculate Max Swap Amount

```typescript
const user = driftClient.getUser();

// Calculate max amount that can be swapped
const { inAmount, outAmount, leverage } = user.getMaxSwapAmount({
  inMarketIndex: 0,   // USDC
  outMarketIndex: 1,  // SOL
});

console.log('Max USDC to swap:', convertToNumber(inAmount, QUOTE_PRECISION));
console.log('Expected SOL out:', convertToNumber(outAmount, new BN(1e9)));
console.log('Resulting leverage:', convertToNumber(leverage, MARGIN_PRECISION));
```

## Simulate Swap Impact

```typescript
const user = driftClient.getUser();

// What will leverage be after swap?
const leverageAfter = user.accountLeverageAfterSwap({
  inMarketIndex: 0,
  outMarketIndex: 1,
  inAmount: driftClient.convertToSpotPrecision(0, 100),
  outAmount: driftClient.convertToSpotPrecision(1, 0.5), // Estimated
});

console.log('Leverage after swap:', convertToNumber(leverageAfter, MARGIN_PRECISION));
```

## Python Examples

```python
# Get swap instructions (Python uses HTTP to Jupiter)
swap_ixs, lookup_tables = await drift_client.get_jupiter_swap_ix_v6(
    out_market_idx=1,   # SOL
    in_market_idx=0,    # USDC
    amount=drift_client.convert_to_spot_precision(100, 0),  # 100 USDC
    slippage_bps=50,
    only_direct_routes=False,
)

# Send transaction
tx_sig = await drift_client.send_ixs(
    swap_ixs,
    address_lookup_table_accounts=lookup_tables,
)

print(f"Swap transaction: {tx_sig}")
```

## Environment Variables

```bash
# Optional: Custom Jupiter API URL
JUPITER_URL=https://quote-api.jup.ag/v6
```

## Error Handling

```typescript
try {
  await driftClient.swap({
    jupiterClient,
    inMarketIndex: 0,
    outMarketIndex: 1,
    amount: driftClient.convertToSpotPrecision(0, 100),
    slippageBps: 50,
  });
} catch (error) {
  if (error.message.includes('InsufficientFunds')) {
    console.error('Not enough tokens to swap');
  } else if (error.message.includes('SlippageExceeded')) {
    console.error('Price moved too much, increase slippage');
  } else if (error.message.includes('InsufficientCollateral')) {
    console.error('Swap would put account below margin requirement');
  } else {
    throw error;
  }
}
```
