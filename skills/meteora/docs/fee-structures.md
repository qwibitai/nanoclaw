# Meteora Fee Structures Guide

Complete guide to understanding and configuring fees across Meteora protocols.

## DLMM Fees

### Fee Components

DLMM uses a dynamic fee system with multiple components:

| Component | Description | Range |
|-----------|-------------|-------|
| Base Fee | Minimum fee charged on all swaps | 0.01% - 10% |
| Variable Fee | Volatility-based additional fee | 0% - varies |
| Protocol Fee | Portion going to Meteora treasury | 0% - 25% |

### Fee Calculation

```
Total Fee = Base Fee + Variable Fee
Trader Pays = Swap Amount × Total Fee
LP Receives = Trader Pays × (1 - Protocol Fee %)
Protocol Receives = Trader Pays × Protocol Fee %
```

### Dynamic Fee Adjustment

The variable fee adjusts based on volatility:

```typescript
// Simplified volatility calculation
volatility = |current_price - reference_price| / reference_price

// Variable fee scales with volatility
variable_fee = base_variable_rate × volatility_multiplier
```

### Fee Tiers

Common bin step configurations:

| Bin Step | Price Change per Bin | Typical Use Case |
|----------|---------------------|------------------|
| 1 | 0.01% | Stablecoin pairs |
| 5 | 0.05% | Correlated assets |
| 10 | 0.1% | Major pairs |
| 25 | 0.25% | Standard pairs |
| 100 | 1% | Volatile pairs |

### Accessing Fee Info

```typescript
const dlmm = await DLMM.create(connection, poolAddress);
const feeInfo = dlmm.getFeeInfo();

console.log('Base Fee:', feeInfo.baseFeeRate, '%');
console.log('Max Fee:', feeInfo.maxFeeRate, '%');
console.log('Protocol Fee:', feeInfo.protocolFeeRate, '%');

// Get current dynamic fee
const dynamicFee = dlmm.getDynamicFee();
console.log('Current Dynamic Fee:', dynamicFee, '%');
```

---

## DAMM v2 Fees

### Fee Configuration

DAMM v2 offers flexible fee configuration:

```typescript
interface PoolFees {
  baseFee: BaseFeeConfig;
  dynamicFee: DynamicFeeConfig | null;
  protocolFeePercent: number;      // 0-100
  partnerFeePercent: number;       // 0-100
  referralFeePercent: number;      // 0-100
}
```

### Base Fee Scheduler Modes

1. **Time Scheduler** (`feeSchedulerMode: 0`)
   - Fees change over time
   - Linear or exponential decay

2. **Market Cap Scheduler** (`feeSchedulerMode: 1`)
   - Fees based on pool size
   - Good for new token launches

3. **Rate Limiter** (`feeSchedulerMode: 2`)
   - Fees based on trading volume
   - Protects against sandwich attacks

### Fee Configuration Example

```typescript
const poolFees = {
  baseFee: {
    cliffFeeNumerator: new BN(2500000),  // 0.25% (fee = numerator / 1e9)
    numberOfPeriod: 0,                    // No decay
    reductionFactor: new BN(0),
    periodFrequency: new BN(0),
    feeSchedulerMode: 0,
  },
  dynamicFee: null,
  protocolFeePercent: 20,    // 20% to protocol
  partnerFeePercent: 0,      // No partner fee
  referralFeePercent: 20,    // 20% referral rebate
};
```

### Fee Conversions

```typescript
// Basis points to numerator
const feeNumerator = cpAmm.bpsToFeeNumerator(25); // 0.25% = 25 bps

// Numerator to basis points
const bps = cpAmm.feeNumeratorToBps(feeNumerator);

// Calculate actual fee
const feePercent = feeNumerator.toNumber() / 1e9 * 100;
```

### Fee Distribution

```
Trading Fee → Protocol (20%) + Partner (if set) + LPs (remainder)
                      ↓
              Meteora Treasury
```

---

## Dynamic Bonding Curve Fees

### Fee Tiers

| Tier | Trading Fee | Migration Fee | Config Address |
|------|-------------|---------------|----------------|
| 1 | 0.25% | 0.25% | `CONFIG_TIER_1` |
| 2 | 0.50% | 0.50% | `CONFIG_TIER_2` |
| 3 | 1.00% | 1.00% | `CONFIG_TIER_3` |
| 4 | 2.00% | 2.00% | `CONFIG_TIER_4` |
| 5 | 4.00% | 4.00% | `CONFIG_TIER_5` |
| 6 | 6.00% | 6.00% | `CONFIG_TIER_6` |

### When to Use Each Tier

- **Tier 1-2**: Established projects, serious launches
- **Tier 3-4**: Community tokens, meme tokens
- **Tier 5-6**: Experimental, high-risk launches

### Migration Fees

When a pool graduates and migrates to DAMM:

```
Migration Fee = Pool Value × Migration Fee Rate
```

This fee is taken during the migration process.

---

## Vault Fees

### Fee Structure

```typescript
interface VaultFees {
  performanceFee: number;  // % of yield
  managementFee: number;   // Annual % of AUM
  withdrawalFee: number;   // % of withdrawal
}
```

### Affiliate Fees

Partners can earn referral fees:

```typescript
const vault = await VaultImpl.create(connection, tokenMint, {
  affiliateId: partnerPubkey,
});

const affiliateInfo = await vault.getAffiliateInfo();
console.log('Fee Rate:', affiliateInfo.feeRate, '%');
console.log('Outstanding:', affiliateInfo.outstandingFee.toString());
```

---

## Stake-for-Fee (M3M3)

### Fee Distribution

Trading fees from the pool are distributed to stakers:

```
Pool Trading Fees → Fee Vault → Distributed to Stakers (proportional)
```

### Claiming Fees

```typescript
const m3m3 = await StakeForFee.create(connection, poolAddress);
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

console.log('Claimable Fees:', balance.claimableFees.toString());

// Claim
if (balance.claimableFees.gt(new BN(0))) {
  const tx = await m3m3.claimFee(wallet.publicKey, null);
  await sendAndConfirmTransaction(connection, tx, [wallet]);
}
```

---

## Fee Optimization Tips

### For Traders

1. **Use limit orders** - Avoid slippage on large trades
2. **Check price impact** - Use `getQuote()` before trading
3. **Consider timing** - Dynamic fees may be lower during stable periods

### For Liquidity Providers

1. **Choose appropriate bin step** - Match pool volatility
2. **Monitor fee earnings** - Claim regularly in active pools
3. **Consider multiple pools** - Diversify across fee tiers

### For Token Launchers

1. **Start with higher fees** - Protect against early manipulation
2. **Decay fees over time** - Use scheduler modes
3. **Lock LP tokens** - Build community trust

---

## Fee Calculation Examples

### DLMM Swap Fee

```typescript
const swapAmount = new BN(1_000_000); // 1 USDC
const feeBps = 30; // 0.3%

const fee = swapAmount.mul(new BN(feeBps)).div(new BN(10000));
const amountAfterFee = swapAmount.sub(fee);

console.log('Fee:', fee.toString());
console.log('After fee:', amountAfterFee.toString());
```

### DAMM v2 Fee

```typescript
const swapAmount = new BN(1_000_000);
const feeNumerator = new BN(2500000); // 0.25%

const fee = swapAmount.mul(feeNumerator).div(new BN(1e9));
console.log('Fee:', fee.toString());
```

### LP Fee Share

```typescript
const totalFees = new BN(100_000); // Total fees collected
const protocolPercent = 20;

const protocolFee = totalFees.mul(new BN(protocolPercent)).div(new BN(100));
const lpFees = totalFees.sub(protocolFee);

console.log('Protocol gets:', protocolFee.toString());
console.log('LPs get:', lpFees.toString());
```
