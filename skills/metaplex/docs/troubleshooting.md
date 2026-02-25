# Metaplex Troubleshooting Guide

Common issues and solutions when working with Metaplex programs.

## Installation Issues

### Module not found errors

**Problem**: `Cannot find module '@metaplex-foundation/...'`

**Solution**:

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Ensure correct packages are installed
npm install @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults
npm install @metaplex-foundation/mpl-core  # For Core NFTs
npm install @metaplex-foundation/mpl-token-metadata  # For Token Metadata
```

### TypeScript errors

**Problem**: Type errors with Metaplex packages

**Solution**:

```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "target": "ES2020"
  }
}
```

### web3.js version conflicts

**Problem**: Multiple web3.js versions causing issues

**Solution**:

```bash
# Use web3.js v1.x with Metaplex (not v2)
npm install @solana/web3.js@1

# Add to package.json resolutions (yarn) or overrides (npm)
{
  "overrides": {
    "@solana/web3.js": "^1.91.0"
  }
}
```

---

## Umi Setup Issues

### Identity not set

**Problem**: `Error: The current identity of the Umi instance is not set`

**Solution**:

```typescript
import { keypairIdentity, generateSigner } from '@metaplex-foundation/umi';

// Option 1: Generate new keypair
const signer = generateSigner(umi);
umi.use(keypairIdentity(signer));

// Option 2: Use existing keypair
const keypair = umi.eddsa.createKeypairFromSecretKey(secretKeyBytes);
const signer = createSignerFromKeypair(umi, keypair);
umi.use(keypairIdentity(signer));

// Option 3: Use wallet adapter (browser)
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
umi.use(walletAdapterIdentity(wallet));
```

### Plugin not registered

**Problem**: `Error: Method not found on Umi instance`

**Solution**:

```typescript
// Make sure to register the plugin
import { mplCore } from '@metaplex-foundation/mpl-core';

const umi = createUmi(rpcUrl)
  .use(mplCore())  // Don't forget this!
```

---

## Transaction Errors

### Transaction too large

**Problem**: `Transaction too large`

**Solution**:

```typescript
// Split into multiple transactions
// Use versioned transactions for more instructions
import { transactionBuilder } from '@metaplex-foundation/umi';

const builder = transactionBuilder()
  .add(instruction1)
  .add(instruction2);

// Or reduce config line batch size for Candy Machine
const batchSize = 5; // Instead of 10+
```

### Blockhash expired

**Problem**: `Blockhash not found` or `Transaction simulation failed: Blockhash not found`

**Solution**:

```typescript
// Get fresh blockhash before sending
const { blockhash, lastValidBlockHeight } = await umi.rpc.getLatestBlockhash();

// Retry with new transaction
await operation.sendAndConfirm(umi, {
  confirm: { commitment: 'confirmed' },
});
```

### Insufficient funds

**Problem**: `Insufficient funds for rent` or `Insufficient lamports`

**Solution**:

```typescript
// Check balance first
const balance = await umi.rpc.getBalance(umi.identity.publicKey);
console.log('Balance:', Number(balance.basisPoints) / 1e9, 'SOL');

// Costs to keep in mind:
// - Core NFT: ~0.003 SOL
// - Token Metadata NFT: ~0.025 SOL
// - Merkle Tree: varies by size
// - Plus transaction fees
```

### Simulation failed

**Problem**: `Transaction simulation failed`

**Solution**:

```typescript
// Get detailed error
try {
  await operation.sendAndConfirm(umi);
} catch (error) {
  console.log('Error:', error);
  console.log('Logs:', error.logs);
}

// Common causes:
// 1. Wrong program ID
// 2. Missing accounts
// 3. Invalid parameters
// 4. Insufficient balance
```

---

## NFT Creation Issues

### Metadata upload fails

**Problem**: `Failed to upload metadata`

**Solution**:

```typescript
// Make sure uploader is configured
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';

const umi = createUmi(rpcUrl)
  .use(irysUploader({
    address: 'https://devnet.irys.xyz', // For devnet
    // address: 'https://node1.irys.xyz', // For mainnet
  }));

// Fund your wallet for uploads (mainnet)
// Arweave uploads require a small fee
```

### URI too long

**Problem**: `URI too long` in Candy Machine

**Solution**:

```typescript
// Use prefixUri in config line settings
configLineSettings: some({
  prefixName: 'NFT #',
  nameLength: 4,
  prefixUri: 'https://arweave.net/',  // Common prefix
  uriLength: 43,  // Just the unique part
  isSequential: false,
}),

// Then add items with just the suffix
await addConfigLines(umi, {
  candyMachine: cmAddress,
  configLines: [
    { name: '0001', uri: 'abc123...'.padEnd(43) }, // 43 chars
  ],
});
```

### Collection verification fails

**Problem**: `Collection not verified`

**Solution**:

```typescript
import { verifyCollectionV1 } from '@metaplex-foundation/mpl-token-metadata';

// You must be the collection update authority
await verifyCollectionV1(umi, {
  metadata: findMetadataPda(umi, { mint: nftMint }),
  collectionMint: collectionMint,
  authority: umi.identity,  // Must be collection update authority
}).sendAndConfirm(umi);
```

---

## Compressed NFT Issues

### DAS API not available

**Problem**: `Method not found` or `DAS API error`

**Solution**:

```typescript
// Use a DAS-compatible RPC
// Not all RPCs support DAS API
const DAS_RPCS = [
  'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  'https://rpc.shyft.to?api_key=YOUR_KEY',
  // etc.
];

// Make sure to use dasApi plugin
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
umi.use(dasApi());
```

### Merkle proof not found

**Problem**: `Unable to get asset proof`

**Solution**:

```typescript
// Asset might not be indexed yet
// Wait a few seconds and retry

async function getProofWithRetry(umi, assetId, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await getAssetWithProof(umi, assetId);
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Failed to get proof after retries');
}
```

### Tree full

**Problem**: `Merkle tree is full`

**Solution**:

```typescript
// Create a larger tree
// maxDepth determines capacity: 2^maxDepth NFTs

const TREE_SIZES = {
  14: 16_384,      // 16K
  17: 131_072,     // 131K
  20: 1_048_576,   // 1M
  24: 16_777_216,  // 16M
  30: 1_073_741_824, // 1B
};

// Create new tree with larger depth
await createTree(umi, {
  merkleTree,
  maxDepth: 20,  // 1M capacity
  maxBufferSize: 256,
});
```

---

## Candy Machine Issues

### Mint limit reached

**Problem**: `Mint limit reached`

**Solution**:

```typescript
// Check mint limit guard
const candyGuard = await fetchCandyGuard(umi, cm.mintAuthority);

if (candyGuard.guards.mintLimit.value) {
  console.log('Limit:', candyGuard.guards.mintLimit.value.limit);
}

// Each wallet has its own counter
// Use different wallet or update guard to remove limit
```

### Start date not reached

**Problem**: `Start date not reached`

**Solution**:

```typescript
// Check start date
if (candyGuard.guards.startDate.value) {
  const startDate = new Date(Number(candyGuard.guards.startDate.value.date) * 1000);
  console.log('Start:', startDate);
  console.log('Now:', new Date());
}

// Update guard to change start date
await updateCandyGuard(umi, {
  candyGuard: cm.mintAuthority,
  guards: {
    startDate: some({ date: dateTime('2024-01-01T00:00:00Z') }),
  },
});
```

### Bot tax applied

**Problem**: `Bot tax charged but mint failed`

**Solution**:

```typescript
// Bot tax is charged when mint fails
// Make sure all guards are satisfied before minting

// Check all required guards
const guards = candyGuard.guards;
if (guards.solPayment.value) {
  // Include SOL payment
}
if (guards.tokenPayment.value) {
  // Include token payment
}
if (guards.allowList.value) {
  // Route to verify allowlist first
}
```

---

## Common Error Messages

### "Account does not exist"

- The account hasn't been created yet
- Wrong public key
- Wrong network (devnet vs mainnet)

### "Invalid account owner"

- Trying to use account with wrong program
- Account is owned by different program

### "Custom program error: 0x..."

- Check the program's error codes
- Convert hex to decimal for error number
- Look up in program documentation

### "Anchor error"

```typescript
// Decode anchor errors
const errorCode = parseInt('0x1770', 16); // 6000
// Check program IDL for error meaning
```

---

## Best Practices

### Always test on devnet first

```typescript
const umi = createUmi('https://api.devnet.solana.com');
```

### Add retry logic

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Max retries reached');
}
```

### Handle errors gracefully

```typescript
try {
  await createNft(umi, { ... }).sendAndConfirm(umi);
} catch (error) {
  if (error.message.includes('insufficient')) {
    console.log('Not enough SOL');
  } else if (error.message.includes('blockhash')) {
    console.log('Transaction expired, retrying...');
  } else {
    throw error;
  }
}
```

---

## Getting Help

1. **Documentation**: [developers.metaplex.com](https://developers.metaplex.com)
2. **Discord**: [discord.gg/metaplex](https://discord.gg/metaplex)
3. **GitHub Issues**: [github.com/metaplex-foundation](https://github.com/metaplex-foundation)
4. **Stack Exchange**: [solana.stackexchange.com](https://solana.stackexchange.com)

When asking for help, include:
- Full error message with stack trace
- Code snippet that causes the error
- Network (devnet/mainnet)
- Package versions (`npm list @metaplex-foundation/*`)
