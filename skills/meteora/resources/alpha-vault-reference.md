# Alpha Vault SDK Reference

Complete API reference for the `@meteora-ag/alpha-vault` package.

## Overview

Alpha Vault is an anti-bot protection mechanism for token launches. It allows projects to protect their community from sniper bots by creating a fair launch environment where:

- Users deposit during a defined window
- Allocations are determined fairly
- Tokens are distributed after launch

## Installation

```bash
npm install @meteora-ag/alpha-vault
```

## AlphaVault Class

### Static Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `create(connection, vaultAddress)` | Create AlphaVault instance | `Connection`, `PublicKey` | `Promise<AlphaVault>` |

### Instance Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getVaultState()` | Get current vault state | - | `Promise<VaultState>` |
| `deposit(params)` | Deposit to vault | `DepositParams` | `Promise<Transaction>` |
| `withdraw(params)` | Withdraw from vault | `WithdrawParams` | `Promise<Transaction>` |
| `claimTokens(params)` | Claim allocated tokens | `ClaimParams` | `Promise<Transaction>` |
| `getUserAllocation(user)` | Get user's allocation | `PublicKey` | `Promise<UserAllocation>` |
| `refreshState()` | Refresh vault state | - | `Promise<void>` |

## Types

### VaultState

```typescript
interface VaultState {
  pool: PublicKey;              // Associated pool address
  quoteMint: PublicKey;         // Quote token (e.g., SOL, USDC)
  baseMint: PublicKey;          // Launch token
  totalDeposited: BN;           // Total deposits received
  maxDeposit: BN;               // Maximum deposit cap
  maxDepositPerUser: BN;        // Per-user deposit limit
  startTime: BN;                // Deposit window start
  endTime: BN;                  // Deposit window end
  claimableTime: BN;            // When claims become available
  tokenPrice: BN;               // Price per token
  totalTokens: BN;              // Total tokens for distribution
  claimed: BN;                  // Total tokens claimed
  vaultMode: VaultMode;         // Current vault mode
  whitelistMode: WhitelistMode; // Whitelist configuration
}
```

### VaultMode Enum

```typescript
enum VaultMode {
  Prorata = 0,      // Pro-rata distribution based on deposit share
  Fcfs = 1,         // First-come-first-served
  WhitelistOnly = 2 // Only whitelisted addresses
}
```

### WhitelistMode Enum

```typescript
enum WhitelistMode {
  None = 0,           // No whitelist
  MerkleProof = 1,    // Merkle tree whitelist
  PermissionedOnly = 2 // Manual whitelist
}
```

### UserAllocation

```typescript
interface UserAllocation {
  user: PublicKey;
  depositAmount: BN;      // Amount deposited
  tokenAllocation: BN;    // Tokens allocated
  claimed: boolean;       // Whether claimed
  claimedAmount: BN;      // Amount already claimed
  remainingAllocation: BN; // Remaining to claim
}
```

### DepositParams

```typescript
interface DepositParams {
  payer: PublicKey;
  amount: BN;
  merkleProof?: Buffer[];  // Required if whitelist mode is MerkleProof
}
```

### WithdrawParams

```typescript
interface WithdrawParams {
  payer: PublicKey;
  amount: BN;
}
```

### ClaimParams

```typescript
interface ClaimParams {
  payer: PublicKey;
}
```

## Usage Examples

### Check Vault Status

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { AlphaVault } from '@meteora-ag/alpha-vault';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const vaultAddress = new PublicKey('VAULT_ADDRESS');

const alphaVault = await AlphaVault.create(connection, vaultAddress);
const vaultState = await alphaVault.getVaultState();

console.log('Total Deposited:', vaultState.totalDeposited.toString());
console.log('Max Deposit:', vaultState.maxDeposit.toString());
console.log('Deposit Start:', new Date(vaultState.startTime.toNumber() * 1000));
console.log('Deposit End:', new Date(vaultState.endTime.toNumber() * 1000));
console.log('Claim Start:', new Date(vaultState.claimableTime.toNumber() * 1000));

// Check vault phase
const now = Date.now() / 1000;
if (now < vaultState.startTime.toNumber()) {
  console.log('Status: Not started');
} else if (now < vaultState.endTime.toNumber()) {
  console.log('Status: Deposit window open');
} else if (now < vaultState.claimableTime.toNumber()) {
  console.log('Status: Waiting for launch');
} else {
  console.log('Status: Claims available');
}
```

### Deposit to Vault

```typescript
const vaultState = await alphaVault.getVaultState();
const now = Date.now() / 1000;

// Check if deposit window is open
if (now < vaultState.startTime.toNumber()) {
  console.error('Deposit window not yet open');
  return;
}

if (now > vaultState.endTime.toNumber()) {
  console.error('Deposit window closed');
  return;
}

// Check remaining capacity
const remaining = vaultState.maxDeposit.sub(vaultState.totalDeposited);
console.log('Remaining capacity:', remaining.toString());

// Deposit
const depositAmount = new BN(1_000_000_000); // 1 SOL
const depositTx = await alphaVault.deposit({
  payer: wallet.publicKey,
  amount: depositAmount,
});

const sig = await sendAndConfirmTransaction(connection, depositTx, [wallet]);
console.log('Deposit successful:', sig);
```

### Deposit with Whitelist

```typescript
// For Merkle proof whitelisted vaults
const merkleProof = getMerkleProof(wallet.publicKey); // Get from project

const depositTx = await alphaVault.deposit({
  payer: wallet.publicKey,
  amount: new BN(1_000_000_000),
  merkleProof: merkleProof,
});

await sendAndConfirmTransaction(connection, depositTx, [wallet]);
```

### Check User Allocation

```typescript
const allocation = await alphaVault.getUserAllocation(wallet.publicKey);

console.log('Deposit Amount:', allocation.depositAmount.toString());
console.log('Token Allocation:', allocation.tokenAllocation.toString());
console.log('Claimed:', allocation.claimed);
console.log('Claimed Amount:', allocation.claimedAmount.toString());
console.log('Remaining:', allocation.remainingAllocation.toString());

// Calculate allocation percentage
const vaultState = await alphaVault.getVaultState();
if (vaultState.totalDeposited.gt(new BN(0))) {
  const percentage = allocation.depositAmount
    .mul(new BN(10000))
    .div(vaultState.totalDeposited);
  console.log('Allocation %:', percentage.toNumber() / 100, '%');
}
```

### Claim Tokens

```typescript
const vaultState = await alphaVault.getVaultState();
const now = Date.now() / 1000;

// Check if claims are available
if (now < vaultState.claimableTime.toNumber()) {
  const timeRemaining = vaultState.claimableTime.toNumber() - now;
  console.log('Claims available in:', timeRemaining, 'seconds');
  return;
}

// Check allocation
const allocation = await alphaVault.getUserAllocation(wallet.publicKey);
if (allocation.claimed) {
  console.log('Already claimed');
  return;
}

if (allocation.tokenAllocation.eq(new BN(0))) {
  console.log('No allocation');
  return;
}

// Claim tokens
const claimTx = await alphaVault.claimTokens({
  payer: wallet.publicKey,
});

const sig = await sendAndConfirmTransaction(connection, claimTx, [wallet]);
console.log('Claim successful:', sig);
console.log('Tokens received:', allocation.tokenAllocation.toString());
```

### Withdraw Before Launch

```typescript
// Withdrawals may be allowed before claims open
const vaultState = await alphaVault.getVaultState();
const now = Date.now() / 1000;

if (now > vaultState.claimableTime.toNumber()) {
  console.error('Cannot withdraw after claims open');
  return;
}

const allocation = await alphaVault.getUserAllocation(wallet.publicKey);
const withdrawTx = await alphaVault.withdraw({
  payer: wallet.publicKey,
  amount: allocation.depositAmount,
});

await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
console.log('Withdrawn successfully');
```

### Monitor Vault Progress

```typescript
async function monitorVault(alphaVault: AlphaVault, intervalMs: number = 5000) {
  const poll = async () => {
    const state = await alphaVault.getVaultState();
    const now = Date.now() / 1000;

    console.clear();
    console.log('=== Alpha Vault Status ===');
    console.log('Total Deposited:', state.totalDeposited.toString());
    console.log('Max Deposit:', state.maxDeposit.toString());

    const fillPercentage = state.totalDeposited
      .mul(new BN(100))
      .div(state.maxDeposit);
    console.log('Fill:', fillPercentage.toString(), '%');

    if (now < state.startTime.toNumber()) {
      const countdown = state.startTime.toNumber() - now;
      console.log('Opens in:', Math.floor(countdown / 60), 'minutes');
    } else if (now < state.endTime.toNumber()) {
      const remaining = state.endTime.toNumber() - now;
      console.log('Closes in:', Math.floor(remaining / 60), 'minutes');
      console.log('Status: OPEN');
    } else if (now < state.claimableTime.toNumber()) {
      const remaining = state.claimableTime.toNumber() - now;
      console.log('Claims in:', Math.floor(remaining / 60), 'minutes');
    } else {
      console.log('Status: CLAIMS OPEN');
      console.log('Claimed:', state.claimed.toString());
    }
  };

  poll();
  setInterval(poll, intervalMs);
}
```

## Allocation Calculation

### Pro-rata Mode

```typescript
function calculateProrataAllocation(
  userDeposit: BN,
  totalDeposited: BN,
  totalTokens: BN
): BN {
  if (totalDeposited.eq(new BN(0))) return new BN(0);
  return userDeposit.mul(totalTokens).div(totalDeposited);
}
```

### FCFS Mode

```typescript
function calculateFcfsAllocation(
  userDeposit: BN,
  tokenPrice: BN
): BN {
  return userDeposit.div(tokenPrice);
}
```

## Resources

- [NPM Package](https://www.npmjs.com/package/@meteora-ag/alpha-vault)
- [GitHub Repository](https://github.com/MeteoraAg/alpha-vault-sdk)
- [Meteora Documentation](https://docs.meteora.ag)
