# Dynamic Vault SDK Reference

Complete API reference for the `@meteora-ag/vault-sdk` package.

## Installation

```bash
npm install @meteora-ag/vault-sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

## VaultImpl Class

### Static Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `create(connection, tokenMint, opt?)` | Create vault instance | `Connection`, `PublicKey`, `VaultOptions?` | `Promise<VaultImpl>` |

### Instance Properties

| Property | Type | Description |
|----------|------|-------------|
| `lpSupply` | `BN` | Current LP token supply |
| `vaultState` | `VaultState` | Current vault state |
| `tokenMint` | `PublicKey` | Underlying token mint |

### Instance Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getVaultSupply()` | Refresh and get LP supply | - | `Promise<BN>` |
| `getWithdrawableAmount()` | Get locked/unlocked amounts | - | `Promise<WithdrawableAmount>` |
| `getUserBalance(user)` | Get user's LP balance | `PublicKey` | `Promise<BN>` |
| `deposit(user, amount)` | Deposit tokens | `PublicKey`, `BN` | `Promise<Transaction>` |
| `withdraw(user, amount)` | Withdraw tokens | `PublicKey`, `BN` | `Promise<Transaction>` |
| `getAffiliateInfo()` | Get affiliate configuration | - | `Promise<AffiliateInfo>` |

## Helper Functions

| Function | Description | Parameters | Returns |
|----------|-------------|------------|---------|
| `getAmountByShare(share, unlocked, supply)` | Convert LP to underlying | `BN`, `BN`, `BN` | `BN` |
| `getUnmintAmount(amount, unlocked, supply)` | Calculate LP needed | `BN`, `BN`, `BN` | `BN` |

## Types

### VaultOptions

```typescript
interface VaultOptions {
  affiliateId?: PublicKey;  // Partner/affiliate public key
}
```

### VaultState

```typescript
interface VaultState {
  tokenVault: PublicKey;
  tokenMint: PublicKey;
  lpMint: PublicKey;
  totalAmount: BN;
  lockedProfitTracker: LockedProfitTracker;
  feeVault: PublicKey;
  operator: PublicKey;
  lockedProfitDegradation: BN;
}
```

### WithdrawableAmount

```typescript
interface WithdrawableAmount {
  locked: BN;    // Amount currently locked in strategies
  unlocked: BN;  // Amount available for withdrawal
}
```

### AffiliateInfo

```typescript
interface AffiliateInfo {
  partner: PublicKey;
  feeRate: number;
  outstandingFee: BN;
}
```

## Usage Examples

### Basic Vault Operations

```typescript
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { VaultImpl } from '@meteora-ag/vault-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const tokenMint = new PublicKey('TOKEN_MINT_ADDRESS');

// Create vault instance
const vault = await VaultImpl.create(connection, tokenMint);

// Get vault info
const lpSupply = await vault.getVaultSupply();
const withdrawable = await vault.getWithdrawableAmount();

console.log('Total LP Supply:', lpSupply.toString());
console.log('Locked:', withdrawable.locked.toString());
console.log('Unlocked:', withdrawable.unlocked.toString());

// Get user balance
const userLpBalance = await vault.getUserBalance(wallet.publicKey);
console.log('User LP Balance:', userLpBalance.toString());
```

### Deposit Tokens

```typescript
const depositAmount = new BN(1_000_000_000); // Amount to deposit

const depositTx = await vault.deposit(wallet.publicKey, depositAmount);
const sig = await sendAndConfirmTransaction(connection, depositTx, [wallet]);
console.log('Deposit successful:', sig);
```

### Withdraw Tokens

```typescript
// Check available balance
const withdrawable = await vault.getWithdrawableAmount();
const userBalance = await vault.getUserBalance(wallet.publicKey);

// Calculate how much underlying we can withdraw
const withdrawAmount = getAmountByShare(userBalance, withdrawable.unlocked, vault.lpSupply);
console.log('Withdrawable amount:', withdrawAmount.toString());

// Withdraw
const withdrawTx = await vault.withdraw(wallet.publicKey, userBalance);
const sig = await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
console.log('Withdraw successful:', sig);
```

### Share Calculations

```typescript
import { getAmountByShare, getUnmintAmount } from '@meteora-ag/vault-sdk';

// Get vault state
const withdrawable = await vault.getWithdrawableAmount();
const lpSupply = await vault.getVaultSupply();

// Convert LP tokens to underlying amount
const userLpBalance = new BN(100_000_000);
const underlyingAmount = getAmountByShare(
  userLpBalance,
  withdrawable.unlocked,
  lpSupply
);
console.log('Underlying value:', underlyingAmount.toString());

// Calculate LP needed for specific withdrawal
const targetWithdraw = new BN(50_000_000);
const lpNeeded = getUnmintAmount(
  targetWithdraw,
  withdrawable.unlocked,
  lpSupply
);
console.log('LP tokens needed:', lpNeeded.toString());
```

### Affiliate Integration

```typescript
// Create vault with affiliate ID
const vaultWithAffiliate = await VaultImpl.create(connection, tokenMint, {
  affiliateId: new PublicKey('PARTNER_PUBLIC_KEY'),
});

// Get affiliate info
const affiliateInfo = await vaultWithAffiliate.getAffiliateInfo();
console.log('Partner:', affiliateInfo.partner.toString());
console.log('Fee Rate:', affiliateInfo.feeRate);
console.log('Outstanding Fee:', affiliateInfo.outstandingFee.toString());

// Deposits/withdrawals work the same - fees are automatically tracked
const depositTx = await vaultWithAffiliate.deposit(wallet.publicKey, new BN(1_000_000_000));
```

### Monitor Vault APY

```typescript
async function monitorVaultYield(vault: VaultImpl, intervalMs: number = 60000) {
  let previousValue: BN | null = null;
  let previousTime: number | null = null;

  setInterval(async () => {
    const withdrawable = await vault.getWithdrawableAmount();
    const lpSupply = await vault.getVaultSupply();
    const currentTime = Date.now();

    // Calculate value per LP token
    const valuePerLp = withdrawable.unlocked.mul(new BN(1e9)).div(lpSupply);

    if (previousValue && previousTime) {
      const timeDiff = currentTime - previousTime;
      const valueDiff = valuePerLp.sub(previousValue);

      // Annualized yield
      const annualizedYield = valueDiff
        .mul(new BN(365 * 24 * 60 * 60 * 1000))
        .div(new BN(timeDiff))
        .mul(new BN(100))
        .div(previousValue);

      console.log('Current APY:', annualizedYield.toString(), '%');
    }

    previousValue = valuePerLp;
    previousTime = currentTime;

    console.log('Value per LP:', valuePerLp.toString());
    console.log('Locked amount:', withdrawable.locked.toString());
  }, intervalMs);
}
```

## Program Address

| Network | Address |
|---------|---------|
| Mainnet-beta | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` |
| Devnet | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` |

## Resources

- [NPM Package](https://www.npmjs.com/package/@meteora-ag/vault-sdk)
- [GitHub Repository](https://github.com/MeteoraAg/vault-sdk)
- [Documentation](https://docs.mercurial.finance)
