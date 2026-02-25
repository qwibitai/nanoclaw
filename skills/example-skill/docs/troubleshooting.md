# Troubleshooting Guide

This file demonstrates the format for troubleshooting documentation.

## Common Issues

### Connection Errors

#### "Failed to connect to RPC"

**Problem**: Cannot establish connection to Solana RPC endpoint.

**Solutions**:

1. Check your RPC URL is correct:
```typescript
// Verify URL format
const connection = new Connection('https://api.mainnet-beta.solana.com');
```

2. Try a different RPC provider:
```typescript
// Free public RPCs (rate limited)
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const DEVNET_RPC = 'https://api.devnet.solana.com';

// Or use a dedicated provider (Helius, QuickNode, etc.)
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
```

3. Check network connectivity

---

### Transaction Errors

#### "Transaction simulation failed"

**Problem**: Transaction fails during simulation.

**Solutions**:

1. Check simulation logs:
```typescript
const simulation = await connection.simulateTransaction(tx);
console.log('Logs:', simulation.value.logs);
console.log('Error:', simulation.value.err);
```

2. Verify all accounts are correct
3. Ensure sufficient balance for fees

#### "Blockhash expired"

**Problem**: Transaction took too long to land.

**Solutions**:

1. Get fresh blockhash immediately before sending:
```typescript
const { blockhash } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;
// Send immediately
```

2. Add retry logic:
```typescript
async function sendWithRetry(tx, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      return await sendAndConfirmTransaction(connection, tx, [wallet]);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(1000);
    }
  }
}
```

#### "Insufficient funds"

**Problem**: Not enough SOL for transaction fees.

**Solutions**:

1. Check balance before transacting:
```typescript
const balance = await connection.getBalance(wallet.publicKey);
const MIN_BALANCE = 0.01 * 1e9; // 0.01 SOL

if (balance < MIN_BALANCE) {
  throw new Error('Insufficient balance for transaction fees');
}
```

2. Ensure you have SOL for rent if creating accounts

---

### Wallet Issues

#### "Wallet file not found"

**Problem**: Cannot load keypair from file.

**Solutions**:

1. Verify file path:
```typescript
import * as fs from 'fs';
import * as path from 'path';

const walletPath = path.resolve('./keypair.json');
console.log('Looking for wallet at:', walletPath);
console.log('File exists:', fs.existsSync(walletPath));
```

2. Check file format (should be JSON array):
```json
[1,2,3,4,5,6,7,8,...] // 64 bytes
```

3. Generate new keypair if needed:
```bash
solana-keygen new -o keypair.json
```

#### "Invalid keypair"

**Problem**: Keypair data is malformed.

**Solutions**:

1. Verify keypair format:
```typescript
const secretKey = JSON.parse(fs.readFileSync('keypair.json', 'utf-8'));
console.log('Array length:', secretKey.length); // Should be 64

const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));
console.log('Public key:', wallet.publicKey.toString());
```

---

### Environment Issues

#### "Module not found"

**Problem**: Required packages not installed.

**Solutions**:

1. Install dependencies:
```bash
npm install @solana/web3.js @solana/spl-token
```

2. Check package.json has correct versions

3. Clear node_modules and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

#### "TypeScript errors"

**Problem**: Type errors when compiling.

**Solutions**:

1. Install type definitions:
```bash
npm install -D typescript @types/node
```

2. Use correct tsconfig.json:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

---

## Debugging Tips

### Enable Verbose Logging

```typescript
// Log connection details
console.log('RPC URL:', connection.rpcEndpoint);
console.log('Commitment:', connection.commitment);

// Log transaction details
console.log('Instructions:', tx.instructions.length);
tx.instructions.forEach((ix, i) => {
  console.log(`Instruction ${i}: ${ix.programId.toString()}`);
});
```

### Simulate Before Sending

```typescript
// Always simulate first in development
const simulation = await connection.simulateTransaction(tx);

if (simulation.value.err) {
  console.error('Simulation failed:', simulation.value.err);
  console.log('Logs:', simulation.value.logs);
  throw new Error('Transaction would fail');
}

// Only send if simulation succeeds
const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
```

### Check Account State

```typescript
async function debugAccount(address: PublicKey) {
  const info = await connection.getAccountInfo(address);

  if (!info) {
    console.log('Account does not exist');
    return;
  }

  console.log('Owner:', info.owner.toString());
  console.log('Lamports:', info.lamports);
  console.log('Data length:', info.data.length);
  console.log('Executable:', info.executable);
}
```

---

## Getting Help

1. **Check documentation** - Review the SKILL.md and resources
2. **Search existing issues** - Someone may have solved this before
3. **Check logs** - Error messages often contain the solution
4. **Test on devnet** - Verify your code works before mainnet
