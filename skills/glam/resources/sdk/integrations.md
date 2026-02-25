# SDK: Integration Clients

## Access Control

Access via `client.access`.

### grantDelegatePermissions

```typescript
await client.access.grantDelegatePermissions(vaultPda: PublicKey, {
  delegate: PublicKey;
  permissions: Permission[];
}, options?: TxOptions);
```

**Permission names** are protocol-scoped. Use them with `glam-cli delegate grant --protocol <PROTOCOL>`. The exact string must match the source (case-sensitive). See [concepts.md](../concepts.md) for the full permission bitmask table.

### revokeDelegate

```typescript
await client.access.revokeDelegate(vaultPda: PublicKey, delegate: PublicKey, options?: TxOptions);
```

### listDelegates

```typescript
const delegates = await client.access.listDelegates(vaultPda: PublicKey);
// Returns: { pubkey: PublicKey, permissions: Permission[] }[]
```

### emergencyAccessUpdate

```typescript
await client.access.emergencyAccessUpdate(vaultPda: PublicKey, {
  disabledIntegrations?: number;
  disabledDelegates?: PublicKey[];
  stateEnabled?: boolean;
}, options?: TxOptions);
```

### enableProtocols

```typescript
await client.access.enableProtocols(vaultPda: PublicKey, integrationProgram: PublicKey, protocolBitmask: number, options?: TxOptions);
```

### disableProtocols

```typescript
await client.access.disableProtocols(vaultPda: PublicKey, integrationProgram: PublicKey, protocolBitmask: number, options?: TxOptions);
```

### setProtocolPolicy

```typescript
await client.access.setProtocolPolicy(vaultPda: PublicKey, integrationProgram: PublicKey, protocolBitflag: number, data: Buffer, options?: TxOptions);
```

### getProgramAndBitflagByProtocolName

Map protocol names to their program address and bitflag for use with `enableProtocols`/`disableProtocols`.

```typescript
import { getProgramAndBitflagByProtocolName } from "@glamsystems/glam-sdk";

const permissionsMap = getProgramAndBitflagByProtocolName();
const [program, bitflag] = permissionsMap["JupiterSwap"];

// Enable Jupiter swap
await client.access.enableProtocols(vaultPda, program, parseInt(bitflag, 2));
```

---

## Policy Encoding

### TransferPolicy

Encode transfer destination allowlists.

```typescript
import { TransferPolicy } from "@glamsystems/glam-sdk";

const policy = new TransferPolicy([]);
policy.allowlist.push(new PublicKey("Destination111..."));
policy.allowlist.push(new PublicKey("Destination222..."));

await client.access.setProtocolPolicy(vaultPda, splProgram, transferBitflag, policy.encode());
```

### SwapPolicy

Encode swap token allowlists.

```typescript
import { SwapPolicy } from "@glamsystems/glam-sdk";

const policy = new SwapPolicy([]);
policy.allowlist.push(new PublicKey("TokenMint111..."));

await client.access.setProtocolPolicy(vaultPda, jupiterProgram, swapAllowlistedBitflag, policy.encode());
```

---

## Jupiter Swap

Access via `client.jupiterSwap`.

### swap

```typescript
const txId = await client.jupiterSwap.swap(vaultPda: PublicKey, {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  slippageBps?: number;      // default: 50
  onlyDirectRoutes?: boolean;
}, options?: TxOptions);
```

### getQuote

```typescript
const quote = await client.jupiterSwap.getQuote({
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  slippageBps?: number;
});
// Returns: { inAmount, outAmount, priceImpactPct, ... }
```

### setMaxSlippage

```typescript
await client.jupiterSwap.setMaxSlippage(vaultPda: PublicKey, maxSlippageBps: number, options?: TxOptions);
```

### allowlistToken

```typescript
await client.jupiterSwap.allowlistToken(vaultPda: PublicKey, mint: PublicKey, options?: TxOptions);
```

---

## Drift Protocol

Access via `client.drift`.

### initialize

```typescript
await client.drift.initialize(vaultPda: PublicKey, options?: TxOptions);
```

### deposit / withdraw

```typescript
await client.drift.deposit(vaultPda: PublicKey, {
  marketIndex: number;
  amount: BN;
}, options?: TxOptions);

await client.drift.withdraw(vaultPda: PublicKey, {
  marketIndex: number;
  amount: BN;
}, options?: TxOptions);
```

### placeSpotOrder

```typescript
await client.drift.placeSpotOrder(vaultPda: PublicKey, {
  marketIndex: number;
  amount: BN;
  direction: "long" | "short";
  price?: BN;
  reduceOnly?: boolean;
}, options?: TxOptions);
```

### placePerpOrder

```typescript
await client.drift.placePerpOrder(vaultPda: PublicKey, {
  marketIndex: number;
  amount: BN;
  direction: "long" | "short";
  price?: BN;
  reduceOnly?: boolean;
  postOnly?: boolean;
}, options?: TxOptions);
```

### cancelOrder

```typescript
await client.drift.cancelOrder(vaultPda: PublicKey, orderId: number, options?: TxOptions);
```

### getPositions

```typescript
const positions = await client.drift.getPositions(vaultPda: PublicKey);
```

### updateUserCustomMarginRatio

```typescript
await client.drift.updateUserCustomMarginRatio(vaultPda: PublicKey, marginRatio: number, options?: TxOptions);
```

### updateUserMarginTradingEnabled

```typescript
await client.drift.updateUserMarginTradingEnabled(vaultPda: PublicKey, enabled: boolean, options?: TxOptions);
```

### updateUserDelegate

```typescript
await client.drift.updateUserDelegate(vaultPda: PublicKey, delegate: PublicKey, options?: TxOptions);
```

### modifyOrder

```typescript
await client.drift.modifyOrder(vaultPda: PublicKey, {
  orderId: number;
  newAmount?: BN;
  newPrice?: BN;
  // ... other modifications
}, options?: TxOptions);
```

### fetchMarketConfigs

```typescript
const configs = await client.drift.fetchMarketConfigs();
// Returns: { perpMarkets: PerpMarketConfig[], spotMarkets: SpotMarketConfig[] }
```

### fetchAndParseDriftUsers

```typescript
const users = await client.drift.fetchAndParseDriftUsers(vaultPda: PublicKey);
// Returns: DriftUser[]
```

---

## Kamino Lending

Access via `client.kaminoLending`.

### initUserMetadata

```typescript
await client.kaminoLending.initUserMetadata(vaultPda: PublicKey, options?: TxOptions);
```

### deposit

```typescript
await client.kaminoLending.deposit(vaultPda: PublicKey, {
  market: PublicKey;
  mint: PublicKey;
  amount: BN;
}, options?: TxOptions);
```

### withdraw

```typescript
await client.kaminoLending.withdraw(vaultPda: PublicKey, {
  market: PublicKey;
  mint: PublicKey;
  amount: BN;
}, options?: TxOptions);
```

### borrow

```typescript
await client.kaminoLending.borrow(vaultPda: PublicKey, {
  market: PublicKey;
  mint: PublicKey;
  amount: BN;
}, options?: TxOptions);
```

### repay

```typescript
await client.kaminoLending.repay(vaultPda: PublicKey, {
  market: PublicKey;
  mint: PublicKey;
  amount: BN;
}, options?: TxOptions);
```

### getPositions

```typescript
const positions = await client.kaminoLending.getPositions(vaultPda: PublicKey);
```

---

## Invest Operations

Access via `client.invest`.

### subscribe

```typescript
await client.invest.subscribe(vaultPda: PublicKey, {
  shareClassIndex: number;
  amount: BN;
}, options?: TxOptions);
```

### claimSubscription

```typescript
await client.invest.claimSubscription(vaultPda: PublicKey, shareClassIndex: number, options?: TxOptions);
```

### redeem

```typescript
await client.invest.redeem(vaultPda: PublicKey, {
  shareClassIndex: number;
  shares: BN;
}, options?: TxOptions);
```

### claimRedemption

```typescript
await client.invest.claimRedemption(vaultPda: PublicKey, shareClassIndex: number, options?: TxOptions);
```

---

## Fee Management

Access via `client.fees`.

### setPrice

```typescript
await client.fees.setPrice(vaultPda: PublicKey, {
  shareClassIndex: number;
  price: BN;
}, options?: TxOptions);
```

### fulfill

```typescript
await client.fees.fulfill(vaultPda: PublicKey, shareClassIndex: number, options?: TxOptions);
```

### claimFees

```typescript
await client.fees.claimFees(vaultPda: PublicKey, options?: TxOptions);
```

### crystallizeFees

```typescript
await client.fees.crystallizeFees(vaultPda: PublicKey, options?: TxOptions);
```

### setProtocolFees

```typescript
await client.fees.setProtocolFees(vaultPda: PublicKey, {
  baseFeeBps: number;
  flowFeeBps: number;
}, options?: TxOptions);
```

---

## Timelock

Access via `client.timelock`.

### get

```typescript
const timelock = await client.timelock.get(vaultPda: PublicKey);
```

### set

```typescript
await client.timelock.set(vaultPda: PublicKey, delaySeconds: number, options?: TxOptions);
```

### apply

```typescript
await client.timelock.apply(vaultPda: PublicKey, options?: TxOptions);
```

### cancel

```typescript
await client.timelock.cancel(vaultPda: PublicKey, options?: TxOptions);
```

---

## Drift Vaults

Access via `client.driftVaults`.

### deposit

```typescript
await client.driftVaults.deposit(driftVault: PublicKey, amount: BN, options?: TxOptions);
```

### requestWithdraw

```typescript
await client.driftVaults.requestWithdraw(driftVault: PublicKey, shares: BN, options?: TxOptions);
```

### cancelWithdrawRequest

```typescript
await client.driftVaults.cancelWithdrawRequest(driftVault: PublicKey, options?: TxOptions);
```

### withdraw

```typescript
await client.driftVaults.withdraw(driftVault: PublicKey, options?: TxOptions);
```

---

## Kamino Vaults

Access via `client.kaminoVaults`.

### deposit

```typescript
await client.kaminoVaults.deposit(kaminoVault: PublicKey, amount: BN, options?: TxOptions);
```

### withdraw

```typescript
await client.kaminoVaults.withdraw(kaminoVault: PublicKey, shares: BN, options?: TxOptions);
```

---

## Kamino Farms

Access via `client.kaminoFarm`.

### stake

```typescript
await client.kaminoFarm.stake(amount: BN, farmState: PublicKey, options?: TxOptions);
```

### unstake

```typescript
await client.kaminoFarm.unstake(amount: BN, farmState: PublicKey, options?: TxOptions);
```

### harvest

```typescript
await client.kaminoFarm.harvest(farmStates: PublicKey[], options?: TxOptions);
```

---

## Marinade Staking

Access via `client.marinade`. Protocol name: `Marinade` (staging).

### deposit (stake SOL for mSOL)

```typescript
await client.marinade.deposit(amount: BN, options?: TxOptions);
```

### depositNative (stake SOL to Marinade Native)

```typescript
await client.marinade.depositNative(amount: BN, options?: TxOptions);
```

### withdrawStakeAccount (withdraw mSOL into stake account)

```typescript
await client.marinade.withdrawStakeAccount(amount: BN, deactivate: boolean, options?: TxOptions);
```

---

## SPL Stake Pool

Access via `client.stakePool`.

### depositSol

```typescript
await client.stakePool.depositSol(stakePool: PublicKey, amount: BN, options?: TxOptions);
```

### unstake

```typescript
await client.stakePool.unstake(lstMint: PublicKey, amount: BN, deactivate: boolean, options?: TxOptions);
```

---

## Price

Access via `client.price`.

### priceVaultIxs

```typescript
const instructions = await client.price.priceVaultIxs();
// Returns instructions to price all vault assets
```

---

## Mint

Access via `client.mint`.

### update

```typescript
await client.mint.update({
  minSubscription?: BN;
  minRedemption?: BN;
}, options?: TxOptions);
```

### pauseSubscription / unpauseSubscription

```typescript
await client.mint.pauseSubscription(options?: TxOptions);
await client.mint.unpauseSubscription(options?: TxOptions);
```

### pauseRedemption / unpauseRedemption

```typescript
await client.mint.pauseRedemption(options?: TxOptions);
await client.mint.unpauseRedemption(options?: TxOptions);
```

### initializeWithStateParams

```typescript
const { mintPda, txId } = await client.mint.initializeWithStateParams(vaultPda: PublicKey, {
  name: string;
  symbol: string;
  decimals: number;
  // ... additional mint config
}, options?: TxOptions);
```

### setTokenAccountsStates

```typescript
await client.mint.setTokenAccountsStates(vaultPda: PublicKey, {
  accounts: PublicKey[];
  frozen: boolean;
}, options?: TxOptions);
```

### forceTransfer

```typescript
await client.mint.forceTransfer(vaultPda: PublicKey, {
  source: PublicKey;
  destination: PublicKey;
  amount: BN;
}, options?: TxOptions);
```

### fetchTokenHolders

```typescript
const holders = await client.mint.fetchTokenHolders(mintPda: PublicKey);
// Returns: { owner: PublicKey, amount: BN }[]
```

---

## Models

### StateModel

```typescript
interface StateModel {
  pubkey: PublicKey;
  name: number[];
  uri: string;
  owner: PublicKey;
  created: CreatedModel;
  integrations: Integration[];
  assets: PublicKey[];
  shareClasses: MintModel[];
  timelockDuration: number;
}
```

### MintModel

```typescript
interface MintModel {
  pubkey: PublicKey;
  name: number[];
  symbol: string;
  uri: string;
  decimals: number;
  supply: BN;
  price: BN;
}
```
