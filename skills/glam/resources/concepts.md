# Concepts Reference

## Fee Structures

Tokenized vaults support five fee categories:

### Vault Fees (burned from shares)
- **Subscription fee**: Percentage of newly issued shares, burned on subscribe
- **Redemption fee**: Percentage of redeemed shares, burned on redeem

### Manager Fees (claimable by manager)
- **Subscription fee**: Percentage of shares issued, claimable by manager
- **Redemption fee**: Percentage of redemption amount, claimable by manager
- **Management fee**: Time-based fee on AUM, paid in newly issued shares. Formula: `shares_owed = AUM * fee_bps * elapsed_time / (year_in_seconds * 10000)`
- **Performance fee**: Charged on profits above high-water mark (HWM) or hurdle rate. Supports `hard` hurdle (fee only on excess above hurdle) and `soft` hurdle (fee on entire gain once hurdle exceeded)

### Protocol Fees
- **Base fee**: Fixed at 0.2% (20 bps) annually for all tokenized vaults
- **Flow fee**: Percentage of manager subscription/redemption fees, paid in shares

Fee configuration in SDK:

```typescript
feeStructure: {
  vault: { subscriptionFeeBps: 10, redemptionFeeBps: 20 },
  manager: { subscriptionFeeBps: 10, redemptionFeeBps: 20 },
  management: { feeBps: 100 },  // 1% annual
  performance: { feeBps: 2000, hurdleRateBps: 500, hurdleType: { hard: {} } },
  protocol: { baseFeeBps: 0, flowFeeBps: 0 }  // overridden by the program; base fee fixed at 20 bps
}
```

---

## Subscription & Redemption Flows

### Instant Mode
- Shares issued/redeemed in same transaction
- Enabled when notice period AND settlement period both = 0
- Best for highly liquid strategies

### Queued Mode
- Request placed in queue with timestamp
- **Notice period**: Minimum wait before fulfillment eligibility. `hard` = strict wait; `soft` = early fulfillment allowed if liquidity available
- **Settlement period**: Maximum window after notice period for fulfillment
- **Cancellation window**: Duration after submission during which user can cancel (must be <= notice period)
- **Permissionless fulfillment**: If enabled, anyone can fulfill; if disabled, only manager

Flow: Request -> Notice Period -> Settlement Window -> Claim

Configuration in SDK:

```typescript
notifyAndSettle: {
  model: { continuous: {} },
  permissionlessFulfillment: false,
  subscribeNoticePeriodType: { soft: {} },
  subscribeNoticePeriod: new BN(0),
  subscribeSettlementPeriod: new BN(0),
  subscribeCancellationWindow: new BN(0),
  redeemNoticePeriodType: { hard: {} },
  redeemNoticePeriod: new BN(86400),     // 1 day
  redeemSettlementPeriod: new BN(86400), // 1 day
  redeemCancellationWindow: new BN(3600), // 1 hour
  timeUnit: { second: {} }
}
```

---

## NAV & Pricing

### AUM Calculation
AUM = Sum of all token values + sum of all protocol positions (Drift, Kamino, staking, etc.)

### NAV (Net Asset Value)
NAV = AUM / Total Share Supply

### Functional Pricing for LSTs
Conversion Rate = Stake Pool SOL Balance / LST Token Supply
Functional Price = SOL Price (USD) x Conversion Rate

Benefits: depeg protection, accurate valuation, reduced manipulation risk.

### Pricing Process
1. Transactions requiring AUM include price instructions for all enabled protocols
2. Price data saved to GLAM State Account's `PricedProtocols` field
3. AUM calculated by summing all valuations
4. Validations ensure fresh oracle data for all vault assets

---

## Program Addresses

### Core Programs

| Program | Mainnet | Staging |
|---------|---------|---------|
| GLAM Protocol | `GLAMpaME8wdTEzxtiYEAa5yD8fZbxZiz2hNtV58RZiEz` | `gstgptmbgJVi5f8ZmSRVZjZkDQwqKa3xWuUtD5WmJHz` |
| GLAM Mint | `GM1NtvvnSXUptTrMCqbogAdZJydZSNv98DoU5AZVLmGh` | `gstgm1M39mhgnvgyScGUDRwNn5kNVSd97hTtyow1Et5` |
| GLAM Config | `gConFzxKL9USmwTdJoeQJvfKmqhJ2CyUaXTyQ8v9TGX` | — |
| GLAM Policies | `po1iCYakK3gHCLbuju4wGzFowTMpAJxkqK1iwUqMonY` | — |

### Integration Programs

| Program | Mainnet | Staging |
|---------|---------|---------|
| CCTP Integration | `G1NTcMDYgNLpDwgnrpSZvoSKQuR9NXG7S3DmtNQCDmrK` | — |
| Drift Integration | `G1NTdrBmBpW43msRQmsf7qXSw3MFBNaqJcAkGiRmRq2F` | `gstgdpMFXKobURsFtStdaMLRSuwdmDUsrndov7kyu9h` |
| Kamino Integration | `G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde` | `gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq` |
| SPL Integration | `G1NTsQ36mjPe89HtPYqxKsjY5HmYsDR6CbD2gd2U2pta` | `gstgs9nJgX8PmRHWAAEP9H7xT3ZkaPWSGPYbj3mXdTa` |
| Marinade Integration | — | `G1NTMNMgmgJAWAD9G3toFVMtNcc21dEyHf3fTXc3t74t` |
| Stake Pool Integration | — | `G1NTstCVkEhGVQPnPe6r7yEyRTvnp3ta63AFkEKxqg25` |

---

## Access Control Framework

Three levels of access control:

### 1. Vault-Level
Rules applied uniformly to all signers (e.g., asset allowlist, max slippage).

### 2. Instruction-Level
Individual instructions require authorization. Controlled by delegate permission bitmasks.

### 3. Parameter-Level
Granular restrictions on instruction parameters (e.g., market allowlists, borrowable asset lists).

### Permission Bitmask Table

Protocol names must match exactly when used with `glam-cli integration enable` or `glam-cli delegate grant --protocol`.

| Protocol | Permission | Bitflag |
|----------|-----------|---------|
| **SystemProgram** | WSOL | 0 |
| **SystemProgram** | Transfer | 1 |
| **StakeProgram** (staging) | Stake | 0 |
| **StakeProgram** (staging) | Unstake | 1 |
| **JupiterSwap** | SwapAny / SwapToAny (staging) | 0 |
| **JupiterSwap** | SwapLST | 1 |
| **JupiterSwap** | SwapAllowlisted | 2 |
| **JupiterSwap** | SwapFromAny (staging only) | 3 |
| **GlamMint** | MintTokens | 0 |
| **GlamMint** | BurnTokens | 1 |
| **GlamMint** | ForceTransfer | 2 |
| **GlamMint** | SetTokenAccountState | 3 |
| **GlamMint** | ClaimFees | 4 |
| **GlamMint** | Fulfill | 5 |
| **GlamMint** | EmergencyUpdate | 6 |
| **GlamMint** | CancelRequest | 7 |
| **GlamMint** | ClaimRequest | 8 |
| **KaminoLend** | Init | 0 |
| **KaminoLend** | Deposit | 1 |
| **KaminoLend** | Withdraw | 2 |
| **KaminoLend** | Borrow | 3 |
| **KaminoLend** | Repay | 4 |
| **KaminoVaults** | Deposit | 0 |
| **KaminoVaults** | Withdraw | 1 |
| **KaminoFarms** | Stake | 0 |
| **KaminoFarms** | Unstake | 1 |
| **KaminoFarms** | HarvestReward | 2 |
| **DriftProtocol** | InitUser | 0 |
| **DriftProtocol** | UpdateUser | 1 |
| **DriftProtocol** | DeleteUser | 2 |
| **DriftProtocol** | Deposit | 3 |
| **DriftProtocol** | Withdraw | 4 |
| **DriftProtocol** | Borrow | 5 |
| **DriftProtocol** | Repay | 6 |
| **DriftProtocol** | CreateModifyOrders | 7 |
| **DriftProtocol** | CancelOrders | 8 |
| **DriftProtocol** | PerpMarkets | 9 |
| **DriftProtocol** | SpotMarkets | 10 |
| **DriftVaults** | Deposit | 0 |
| **DriftVaults** | Withdraw | 1 |
| **SplToken** | Transfer | 0 |
| **CCTP** | Transfer | 0 |
| **Marinade** (staging) | Stake | 0 |
| **Marinade** (staging) | Unstake | 1 |
| **StakePool** (staging) | DepositSol | 0 |
| **StakePool** (staging) | DepositStake | 1 |
| **StakePool** (staging) | DepositSolAny | 2 |
| **StakePool** (staging) | DepositStakeAny | 3 |
| **StakePool** (staging) | WithdrawSol | 4 |
| **StakePool** (staging) | WithdrawStake | 5 |
| **SanctumSingle** (staging) | DepositSol | 0 |
| **SanctumSingle** (staging) | DepositStake | 1 |
| **SanctumSingle** (staging) | DepositSolAny | 2 |
| **SanctumSingle** (staging) | DepositStakeAny | 3 |
| **SanctumSingle** (staging) | WithdrawSol | 4 |
| **SanctumSingle** (staging) | WithdrawStake | 5 |
| **SanctumMulti** (staging) | DepositSol | 0 |
| **SanctumMulti** (staging) | DepositStake | 1 |
| **SanctumMulti** (staging) | DepositSolAny | 2 |
| **SanctumMulti** (staging) | DepositStakeAny | 3 |
| **SanctumMulti** (staging) | WithdrawSol | 4 |
| **SanctumMulti** (staging) | WithdrawStake | 5 |
