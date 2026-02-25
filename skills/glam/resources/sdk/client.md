# SDK: GlamClient

Main entry point for SDK operations.

## Installation

```bash
npm install @glamsystems/glam-sdk
# or
yarn add @glamsystems/glam-sdk
# or
pnpm add @glamsystems/glam-sdk
```

## Constructor

```typescript
import { GlamClient } from "@glamsystems/glam-sdk";

const client = new GlamClient({
  cluster?: "mainnet-beta" | "devnet" | "localnet";
  wallet?: Wallet;
  provider?: AnchorProvider;
  statePda?: PublicKey;
  jupiterApiKey?: string;
});
```

**Default initialization:** When no explicit provider or wallet is given, GlamClient uses `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` environment variables.

**Options:**

| Option          | Type           | Description                                     |
| --------------- | -------------- | ----------------------------------------------- |
| `cluster`       | string         | Cluster to connect to (default: "mainnet-beta") |
| `wallet`        | Wallet         | Wallet adapter for signing                      |
| `provider`      | AnchorProvider | Custom Anchor provider                          |
| `statePda`      | PublicKey      | Default vault state PDA                         |
| `jupiterApiKey` | string         | Jupiter API key                                 |

## Custom Wallet Patterns

### ReadOnlyWallet (no signing)

```typescript
import { Wallet } from "@coral-xyz/anchor";

class ReadOnlyWallet implements Wallet {
  constructor(public publicKey: PublicKey) {}
  async signTransaction() {
    throw new Error("Read-only");
  }
  async signAllTransactions() {
    throw new Error("Read-only");
  }
}

const client = new GlamClient({
  wallet: new ReadOnlyWallet(new PublicKey("...")),
});
// Can query vault data but cannot sign transactions
```

### Keypair Wallet

```typescript
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { Keypair } from "@solana/web3.js";
import fs from "fs";

const secretKey = JSON.parse(fs.readFileSync("/path/to/keypair.json", "utf8"));
const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
const wallet = new NodeWallet(keypair);

const client = new GlamClient({ wallet });
```

### AnchorProvider Setup

```typescript
import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

const client = new GlamClient({ provider });
```

## Properties

```typescript
// Sub-clients (lazy-loaded)
client.vault; // Vault operations
client.state; // Vault state account management
client.access; // Delegate/permission management
client.jupiterSwap; // Jupiter swap operations
client.drift; // Drift protocol operations
client.driftVaults; // Drift managed vault operations
client.kaminoLending; // Kamino lending operations
client.kaminoVaults; // Kamino automated vault operations
client.kaminoFarm; // Kamino farm/staking operations
client.marinade; // Marinade staking operations
client.stakePool; // SPL stake pool operations
client.stake; // Native staking operations
client.invest; // Subscription/redemption
client.fees; // Fee management
client.price; // NAV pricing operations
client.mint; // Share class mint operations
client.timelock; // Timelock operations
client.cctp; // Cross-chain USDC bridging

// Core properties
client.program; // Anchor program instance
client.provider; // Anchor provider
client.connection; // Solana connection
```

---

## Vault Operations

Access via `client.vault`.

### create

```typescript
const { vaultPda, txId } = await client.vault.create({
  name: string;
  assets?: PublicKey[];
  manager?: PublicKey;
  shareClassName?: string;
  shareClassSymbol?: string;
  shareClassDecimals?: number;
}, options?: TxOptions);
```

### fetch

```typescript
const state = await client.vault.fetch(vaultPda: PublicKey);
// Returns: StateModel
```

### list

```typescript
const vaults = await client.vault.list({
  manager?: PublicKey;
  owner?: PublicKey;
});
// Returns: StateModel[]
```

### update

```typescript
await client.vault.update(vaultPda: PublicKey, {
  name?: string;
  uri?: string;
}, options?: TxOptions);
```

### close

```typescript
await client.vault.close(vaultPda: PublicKey, options?: TxOptions);
```

### getBalances

```typescript
const balances = await client.vault.getBalances(vaultPda: PublicKey);
// Returns: { mint: PublicKey, amount: BN, decimals: number }[]
```

### wrapSol / unwrapSol

```typescript
await client.vault.wrapSol(vaultPda: PublicKey, amount: BN, options?: TxOptions);
await client.vault.unwrapSol(vaultPda: PublicKey, amount: BN, options?: TxOptions);
```

### allowlistAsset

```typescript
await client.vault.allowlistAsset(vaultPda: PublicKey, mint: PublicKey, options?: TxOptions);
```

**Integration management** (enable/disable protocols) is handled by `client.access`. See [Integrations](./integrations.md).

---

## State Operations

Access via `client.state`.

### initialize

```typescript
const { statePda, txId } = await client.state.initialize({
  name: string;
  manager?: PublicKey;
  // ... additional state params
}, options?: TxOptions);
```

### update

```typescript
await client.state.update(vaultPda: PublicKey, {
  name?: string;
  uri?: string;
  // ... additional fields
}, options?: TxOptions);
```

### extend

```typescript
await client.state.extend(vaultPda: PublicKey, newBytes: number, options?: TxOptions);
```

### close

```typescript
await client.state.close(vaultPda: PublicKey, options?: TxOptions);
```

---

## CCTP Operations (Cross-Chain)

Access via `client.cctp`.

### bridgeUsdc

```typescript
const txId = await client.cctp.bridgeUsdc(vaultPda: PublicKey, {
  amount: BN;
  destinationDomain: number;
  recipient: string; // Hex address
}, options?: TxOptions);
```

### receiveUsdc

```typescript
const txId = await client.cctp.receiveUsdc(vaultPda: PublicKey, {
  sourceDomain: number;
  message: Buffer;
  attestation: Buffer;
}, options?: TxOptions);
```

### getIncomingBridgeEvents

```typescript
const events = await client.cctp.getIncomingBridgeEvents(vaultPda: PublicKey, {
  limit?: number;
});
```

### getOutgoingBridgeEvents

```typescript
const events = await client.cctp.getOutgoingBridgeEvents(vaultPda: PublicKey, {
  limit?: number;
});
```

---

## Transaction Options

All methods that submit transactions accept `TxOptions`:

```typescript
interface TxOptions {
  signer?: Keypair;
  computeUnitLimit?: number;
  getPriorityFeeMicroLamports?: () => Promise<number>;
  maxFeeLamports?: number;
  useMaxFee?: boolean;
  preInstructions?: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  simulate?: boolean;
}
```

**Example:**

```typescript
await client.vault.create(
  {
    name: "My Vault",
  },
  {
    computeUnitLimit: 400_000,
    simulate: true,
  },
);
```

---

## TxBuilder Pattern

SDK sub-clients expose a `txBuilder` property for building instructions without sending:

```typescript
// Get instructions for multisig or custom transaction building
const ix = await client.access.txBuilder.enableDisableProtocolsIx(
  program,
  bitflag,
  enable,
  signer,
);
const ix2 = await client.access.txBuilder.grantDelegatePermissionsIx(
  delegate,
  permissions,
  protocol,
  signer,
);

// Use with Squads multisig or custom transaction builders
```

See [Multisig](./multisig.md) for full example.

---

## Models

### StateAccountType

```typescript
enum StateAccountType {
  VAULT = "vault",
  TOKENIZED_VAULT = "tokenizedVault",
}
```

### StateModel

```typescript
interface StateModel {
  pubkey: PublicKey;
  accountType: StateAccountType;
  name: number[]; // On-chain byte array; use nameToChars() to convert strings
  uri: string;
  owner: PublicKey;
  portfolioManagerName: number[];
  created: CreatedModel;
  enabled: boolean;
  integrations: Integration[];
  assets: PublicKey[];
  borrowable: PublicKey[];
  shareClasses: MintModel[];
  timelockDuration: number;
  delegateAcls: DelegateAcl[];
  integrationAcls: IntegrationAcl[];
}
```

### MintModel (full)

```typescript
interface MintModel {
  pubkey: PublicKey;
  name: number[]; // On-chain byte array
  symbol: string;
  uri: string;
  decimals: number;
  supply: BN;
  price: BN;
  yearInSeconds: number;
  baseAssetMint: PublicKey;
  maxCap: BN | null;
  minSubscription: BN | null;
  minRedemption: BN | null;
  lockupPeriod: number | null;
  permanentDelegate: PublicKey | null;
  defaultAccountStateFrozen: boolean | null;
  allowlist: PublicKey[] | null;
  blocklist: PublicKey[] | null;
  feeStructure: {
    vault: { subscriptionFeeBps: number; redemptionFeeBps: number };
    manager: { subscriptionFeeBps: number; redemptionFeeBps: number };
    management: { feeBps: number };
    performance: { feeBps: number; hurdleRateBps: number; hurdleType: object };
    protocol: { baseFeeBps: number; flowFeeBps: number };
  };
  notifyAndSettle: {
    model: object;
    permissionlessFulfillment: boolean;
    subscribeNoticePeriodType: object;
    subscribeNoticePeriod: BN;
    subscribeSettlementPeriod: BN;
    subscribeCancellationWindow: BN;
    redeemNoticePeriodType: object;
    redeemNoticePeriod: BN;
    redeemSettlementPeriod: BN;
    redeemCancellationWindow: BN;
    timeUnit: object;
  };
}
```

---

## Utility Functions

### nameToChars

Convert string vault name to character array format for on-chain storage.

```typescript
import { nameToChars } from "@glamsystems/glam-sdk";

const name = nameToChars("My Vault");
```

### intoVersionedTransaction

Convert a legacy Transaction to a VersionedTransaction.

```typescript
const vTx = await client.intoVersionedTransaction(tx, txOptions);
```

### sendAndConfirm

Send and confirm a versioned transaction.

```typescript
const txSig = await client.sendAndConfirm(vTx);
```

### blockhashWithCache

Cached recent blockhash for efficient transaction building.

```typescript
const blockhash = (await client.blockhashWithCache.get()).blockhash;
```

### PDA Derivation

```typescript
import { deriveVaultPda, deriveShareClassPda } from "@glamsystems/glam-sdk";

const [vaultPda] = deriveVaultPda(manager: PublicKey, name: string);
const [shareClassPda] = deriveShareClassPda(vaultPda: PublicKey, index: number);
```

### Constants

```typescript
import { GLAM_PROGRAM_ID, WSOL, MSOL, USDC, JUP } from "@glamsystems/glam-sdk";

WSOL;  // So11111111111111111111111111111111111111112
MSOL;  // mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So
USDC;  // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
JUP;   // JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN
```
