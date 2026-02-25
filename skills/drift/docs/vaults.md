# Drift Vaults Documentation

## Overview

Drift Vaults are permissionless, delegated trading pools on Solana. Users deposit tokens into a vault managed by a delegate (manager) who can trade on behalf of the vault but cannot directly withdraw user funds.

## Key Concepts

### Roles

| Role | Capabilities |
|------|-------------|
| **Manager/Delegate** | Place/cancel orders, manage positions, update vault parameters |
| **Depositor** | Deposit funds, request withdrawals, view share balance |
| **Protocol** | Enforces rules, calculates fees, manages redemptions |

### Vault Parameters

| Parameter | Description |
|-----------|-------------|
| `spotMarketIndex` | Which token the vault accepts (0 = USDC) |
| `redeemPeriod` | Waiting time before withdrawal completes |
| `maxTokens` | Maximum capacity of the vault |
| `managementFee` | Annual fee charged to depositors (basis points) |
| `profitShare` | Percentage of profits taken by manager |
| `permissioned` | Whether deposits require manager approval |
| `minDepositAmount` | Minimum deposit amount |

### Share Calculation

Vault shares represent proportional ownership:

```
User Shares = (Deposit Amount / Total Vault Equity) × Total Shares
Withdrawal Amount = (User Shares / Total Shares) × Total Vault Equity
```

### Fees

**Management Fee**: Charged continuously, annualized
```
Daily Fee = (Management Fee / 365) × User Share Value
```

**Profit Share**: Charged only on realized gains
```
Manager Profit = (Vault Profit × Profit Share %) × User Share Proportion
```

## Vault Lifecycle

### 1. Creation (Manager)

```typescript
const vault = await vaultClient.initializeVault({
  name: encodeName('MyVault'),
  spotMarketIndex: 0,
  redeemPeriod: new BN(604800), // 7 days
  maxTokens: new BN(1_000_000_000_000), // 1M USDC
  managementFee: new BN(200), // 2%
  profitShare: 2000, // 20%
  permissioned: false,
  minDepositAmount: new BN(100_000_000), // 100 USDC
});
```

### 2. Deposits (Users)

```typescript
// Permissionless vault - automatic depositor creation
await vaultClient.deposit(vaultPubkey, amount);

// Permissioned vault - manager must approve first
await vaultClient.initializeVaultDepositor(vaultPubkey, userPubkey);
await vaultClient.deposit(vaultPubkey, amount);
```

### 3. Trading (Manager)

```typescript
// Place order for vault
await vaultClient.placePerpOrder(vaultPubkey, {
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(10),
  price: driftClient.convertToPricePrecision(100),
});
```

### 4. Withdrawals (Users)

```typescript
// Step 1: Request withdrawal
await vaultClient.requestWithdraw(vaultPubkey, shares, WithdrawUnit.SHARES);

// Step 2: Wait for redeem period...

// Step 3: Complete withdrawal
await vaultClient.withdraw(vaultPubkey);
```

## Security Model

### What Managers CAN Do
- Place and cancel orders (perp and spot)
- Manage positions
- Update vault parameters (with restrictions)
- Deposit their own funds

### What Managers CANNOT Do
- Withdraw user funds directly
- Bypass redeem period
- Increase redeem period (can only decrease)
- Access depositor private keys

### User Protections
- Redeem period ensures orderly withdrawals
- Share-based accounting prevents manipulation
- Transparent on-chain performance tracking
- Manager cannot prevent withdrawal requests

## Best Practices

### For Managers
1. Start with smaller max capacity
2. Use reasonable redeem periods (3-7 days)
3. Set appropriate management fees
4. Maintain clear communication with depositors
5. Monitor vault health and positions

### For Depositors
1. Research manager track record
2. Understand fee structure
3. Be aware of redeem period
4. Diversify across multiple vaults
5. Monitor vault performance

## Vault CLI Commands

```bash
# Initialize vault
npx @drift-labs/vaults-sdk init-vault \
  --name "MyVault" \
  --market-index 0 \
  --redeem-period 604800 \
  --max-tokens 1000000000000 \
  --management-fee 200 \
  --profit-share 2000

# Manager deposit
npx @drift-labs/vaults-sdk manager-deposit \
  --vault <VAULT_PUBKEY> \
  --amount 10000000000

# User deposit
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

# Update vault
npx @drift-labs/vaults-sdk manager-update-vault \
  --vault <VAULT_PUBKEY> \
  --redeem-period 259200
```

## Resources

- [Drift Vaults SDK](https://github.com/drift-labs/drift-vaults)
- [Vaults UI Template](https://github.com/drift-labs/vaults-ui-template)
- [Drift Vaults Documentation](https://docs.drift.trade/drift-vaults)
