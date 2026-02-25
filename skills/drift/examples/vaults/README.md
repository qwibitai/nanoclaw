# Drift Vaults Examples

Drift Vaults are permissionless pools where users deposit tokens that are managed by a single delegate. The delegate can only trade on behalf of the vault - they cannot withdraw funds directly.

## Vault Concepts

- **Manager/Delegate**: Can place and cancel orders for the vault
- **Depositors**: Users who deposit funds into the vault
- **Redeem Period**: Waiting period before withdrawals complete
- **Management Fee**: Annual fee charged to depositors
- **Profit Share**: Percentage of profits taken by manager

## Using Drift Vault SDK

### Installation

```bash
npm install @drift-labs/vaults-sdk @drift-labs/sdk
```

### Setup Vault Client

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { VaultClient, getVaultClient } from '@drift-labs/vaults-sdk';
import { DriftClient, BulkAccountLoader } from '@drift-labs/sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = new Wallet(keypair);

// First create DriftClient
const driftClient = new DriftClient({
  connection,
  wallet,
  env: 'mainnet-beta',
  accountSubscription: {
    type: 'polling',
    accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
  },
});

await driftClient.subscribe();

// Then create VaultClient
const vaultClient = getVaultClient(connection, wallet, driftClient);
await vaultClient.subscribe();
```

## Creating a Vault (Manager)

### Initialize Vault

```typescript
import { BN } from '@coral-xyz/anchor';

const vaultName = 'MyTradingVault';
const spotMarketIndex = 0; // USDC

// Create vault
const [vaultPubkey] = await vaultClient.initializeVault({
  name: encodeName(vaultName),
  spotMarketIndex,
  redeemPeriod: new BN(60 * 60 * 24 * 7), // 7 days in seconds
  maxTokens: new BN(1_000_000 * 1e6), // 1M USDC max
  managementFee: new BN(200), // 2% annual (basis points * 100)
  profitShare: 2000, // 20% (basis points)
  permissioned: false, // Anyone can deposit
  minDepositAmount: new BN(100 * 1e6), // 100 USDC minimum
});

console.log('Vault created:', vaultPubkey.toString());
```

### Update Vault Settings

```typescript
// Update vault parameters (manager only)
await vaultClient.updateVault(vaultPubkey, {
  redeemPeriod: new BN(60 * 60 * 24 * 3), // Reduce to 3 days
  maxTokens: new BN(2_000_000 * 1e6), // Increase max to 2M
  minDepositAmount: new BN(50 * 1e6), // Lower minimum
});
```

### Manager Deposit

```typescript
// Manager deposits to vault
const amount = new BN(10_000 * 1e6); // 10,000 USDC
await vaultClient.managerDeposit(vaultPubkey, amount);
```

## Depositing to Vault (User)

### Initialize Depositor Account

```typescript
// For permissioned vaults, manager must initialize depositor first
// For permissionless vaults, this happens automatically on deposit

const depositorPubkey = userWallet.publicKey;

// Permissioned vault: Manager initializes depositor
await vaultClient.initializeVaultDepositor(vaultPubkey, depositorPubkey);
```

### Deposit

```typescript
const amount = new BN(1_000 * 1e6); // 1,000 USDC

// Deposit to vault
await vaultClient.deposit(vaultPubkey, amount);

console.log('Deposited to vault');
```

### Check Vault Balance

```typescript
// Get depositor account
const depositorAccount = await vaultClient.getVaultDepositorAccount(
  vaultPubkey,
  userWallet.publicKey
);

console.log('Shares:', depositorAccount.vaultShares.toString());
console.log('Last withdraw request:', depositorAccount.lastWithdrawRequest);
```

## Withdrawing from Vault (User)

### Request Withdrawal

```typescript
// Start withdrawal (begins redeem period)
const sharesToWithdraw = depositorAccount.vaultShares; // All shares

await vaultClient.requestWithdraw(
  vaultPubkey,
  sharesToWithdraw,
  WithdrawUnit.SHARES
);

console.log('Withdrawal requested, waiting for redeem period');
```

### Complete Withdrawal

```typescript
// After redeem period has passed
await vaultClient.withdraw(vaultPubkey);

console.log('Withdrawal completed');
```

### Cancel Withdrawal Request

```typescript
// Cancel pending withdrawal request
await vaultClient.cancelWithdrawRequest(vaultPubkey);
```

## Trading as Vault Manager

The vault delegate can trade using the vault's DriftClient:

```typescript
// Get vault's user account
const vaultUser = await vaultClient.getVaultUser(vaultPubkey);

// Place order for vault
await vaultClient.placePerpOrder(vaultPubkey, {
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100),
});

// Cancel order
await vaultClient.cancelOrder(vaultPubkey, orderId);
```

## Query Vault Data

### Get Vault Account

```typescript
const vault = await vaultClient.getVault(vaultPubkey);

console.log('Name:', decodeName(vault.name));
console.log('Manager:', vault.manager.toString());
console.log('Total shares:', vault.totalShares.toString());
console.log('User shares:', vault.userShares.toString());
console.log('Management fee:', vault.managementFee.toNumber() / 100, '%');
console.log('Profit share:', vault.profitShare / 100, '%');
console.log('Redeem period:', vault.redeemPeriod.toNumber() / 86400, 'days');
```

### Get Vault Equity

```typescript
const equity = await vaultClient.calculateVaultEquity(vaultPubkey);
console.log('Vault equity:', equity.toString());
```

### List All Vaults

```typescript
const vaults = await vaultClient.getAllVaults();

for (const vault of vaults) {
  console.log('Vault:', vault.publicKey.toString());
  console.log('  Name:', decodeName(vault.account.name));
  console.log('  Manager:', vault.account.manager.toString());
}
```

## CLI Commands (Alternative)

The vault SDK also provides CLI commands:

```bash
# Initialize vault
npx @drift-labs/vaults-sdk init-vault \
  --name "MyVault" \
  --market-index 0 \
  --redeem-period 604800 \
  --max-tokens 1000000000000

# Deposit to vault
npx @drift-labs/vaults-sdk deposit \
  --vault <VAULT_PUBKEY> \
  --amount 1000000000

# Request withdrawal
npx @drift-labs/vaults-sdk request-withdraw \
  --vault <VAULT_PUBKEY> \
  --shares 1000000

# Complete withdrawal
npx @drift-labs/vaults-sdk withdraw \
  --vault <VAULT_PUBKEY>
```

## Helper Functions

```typescript
// Encode vault name (max 32 bytes)
function encodeName(name: string): number[] {
  const buffer = Buffer.alloc(32);
  buffer.write(name);
  return Array.from(buffer);
}

// Decode vault name
function decodeName(name: number[]): string {
  return Buffer.from(name).toString('utf-8').replace(/\0/g, '');
}
```

## Vault Resources

- [Drift Vaults Documentation](https://docs.drift.trade/drift-vaults)
- [Vaults SDK Repository](https://github.com/drift-labs/drift-vaults)
- [Vaults UI Template](https://github.com/drift-labs/vaults-ui-template)
