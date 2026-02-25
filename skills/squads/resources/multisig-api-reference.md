# Squads V4 Multisig API Reference

Complete API reference for the `@sqds/multisig` SDK.

## Installation

```bash
npm install @sqds/multisig @solana/web3.js
```

## Import

```typescript
import * as multisig from "@sqds/multisig";
import { Connection, Keypair, PublicKey, TransactionMessage } from "@solana/web3.js";
```

---

## Constants

```typescript
// Program ID
multisig.PROGRAM_ID // PublicKey: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
multisig.PROGRAM_ADDRESS // string: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
```

---

## PDA Derivation Functions

### getMultisigPda

Derive the multisig account PDA.

```typescript
const [multisigPda, bump] = multisig.getMultisigPda({
  createKey: PublicKey, // Unique key used to derive the multisig
  programId?: PublicKey, // Optional, defaults to PROGRAM_ID
});
```

### getVaultPda

Derive a vault PDA for the multisig.

```typescript
const [vaultPda, bump] = multisig.getVaultPda({
  multisigPda: PublicKey,
  index: number, // Vault index (0, 1, 2, ...)
  programId?: PublicKey,
});
```

### getTransactionPda

Derive a transaction PDA.

```typescript
const [transactionPda, bump] = multisig.getTransactionPda({
  multisigPda: PublicKey,
  index: bigint, // Transaction index
  programId?: PublicKey,
});
```

### getProposalPda

Derive a proposal PDA.

```typescript
const [proposalPda, bump] = multisig.getProposalPda({
  multisigPda: PublicKey,
  transactionIndex: bigint,
  programId?: PublicKey,
});
```

### getBatchPda

Derive a batch PDA.

```typescript
const [batchPda, bump] = multisig.getBatchPda({
  multisigPda: PublicKey,
  batchIndex: bigint,
  programId?: PublicKey,
});
```

### getSpendingLimitPda

Derive a spending limit PDA.

```typescript
const [spendingLimitPda, bump] = multisig.getSpendingLimitPda({
  multisigPda: PublicKey,
  createKey: PublicKey,
  programId?: PublicKey,
});
```

### getProgramConfigPda

Derive the program config PDA.

```typescript
const [programConfigPda, bump] = multisig.getProgramConfigPda({
  programId?: PublicKey,
});
```

### getEphemeralSignerPda

Derive an ephemeral signer PDA for CPI.

```typescript
const [ephemeralSignerPda, bump] = multisig.getEphemeralSignerPda({
  transactionPda: PublicKey,
  ephemeralSignerIndex: number,
  programId?: PublicKey,
});
```

---

## RPC Methods (multisig.rpc)

RPC methods build, sign, and send transactions.

### multisigCreateV2

Create a new multisig account.

```typescript
const signature = await multisig.rpc.multisigCreateV2({
  connection: Connection,
  createKey: Keypair, // One-time use keypair
  creator: Keypair | Signer, // Transaction fee payer and initial creator
  multisigPda: PublicKey,
  configAuthority: PublicKey | null, // null = immutable config
  threshold: number, // Required approvals
  members: Member[], // Array of { key: PublicKey, permissions: Permissions }
  timeLock: number, // Seconds to wait after approval (0 = no delay)
  rentCollector: PublicKey | null, // Account to receive rent on close
  memo?: string,
  sendOptions?: SendOptions,
});
```

### vaultTransactionCreate

Create a vault transaction.

```typescript
const signature = await multisig.rpc.vaultTransactionCreate({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  creator: PublicKey,
  vaultIndex: number,
  ephemeralSigners: number, // Number of ephemeral signers needed
  transactionMessage: TransactionMessage,
  addressLookupTableAccounts?: AddressLookupTableAccount[],
  memo?: string,
  sendOptions?: SendOptions,
});
```

### proposalCreate

Create a proposal for a transaction.

```typescript
const signature = await multisig.rpc.proposalCreate({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  creator: Keypair | Signer,
  isDraft?: boolean, // Create as draft (not active)
  sendOptions?: SendOptions,
});
```

### proposalActivate

Activate a draft proposal.

```typescript
const signature = await multisig.rpc.proposalActivate({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: Keypair | Signer,
  sendOptions?: SendOptions,
});
```

### proposalApprove

Approve a proposal.

```typescript
const signature = await multisig.rpc.proposalApprove({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: Keypair | Signer,
  memo?: string,
  sendOptions?: SendOptions,
});
```

### proposalReject

Reject a proposal.

```typescript
const signature = await multisig.rpc.proposalReject({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: Keypair | Signer,
  memo?: string,
  sendOptions?: SendOptions,
});
```

### proposalCancel

Cancel a proposal.

```typescript
const signature = await multisig.rpc.proposalCancel({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: Keypair | Signer,
  memo?: string,
  sendOptions?: SendOptions,
});
```

### vaultTransactionExecute

Execute an approved vault transaction.

```typescript
const signature = await multisig.rpc.vaultTransactionExecute({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: PublicKey,
  signers?: Keypair[], // Additional signers if needed
  sendOptions?: SendOptions,
});
```

### configTransactionCreate

Create a config change transaction.

```typescript
const signature = await multisig.rpc.configTransactionCreate({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  creator: PublicKey,
  actions: ConfigAction[], // Array of config actions
  memo?: string,
  sendOptions?: SendOptions,
});
```

### configTransactionExecute

Execute a config transaction.

```typescript
const signature = await multisig.rpc.configTransactionExecute({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: PublicKey,
  rentPayer?: PublicKey,
  spendingLimitCreateKeys?: PublicKey[],
  sendOptions?: SendOptions,
});
```

### batchCreate

Create a new batch.

```typescript
const signature = await multisig.rpc.batchCreate({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  batchIndex: bigint,
  creator: Keypair | Signer,
  vaultIndex: number,
  memo?: string,
  sendOptions?: SendOptions,
});
```

### batchAddTransaction

Add a transaction to a batch.

```typescript
const signature = await multisig.rpc.batchAddTransaction({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  batchIndex: bigint,
  transactionIndex: number, // Index within the batch
  vaultIndex: number,
  transactionMessage: TransactionMessage,
  ephemeralSigners?: number,
  addressLookupTableAccounts?: AddressLookupTableAccount[],
  sendOptions?: SendOptions,
});
```

### batchExecuteTransaction

Execute a transaction within a batch.

```typescript
const signature = await multisig.rpc.batchExecuteTransaction({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  batchIndex: bigint,
  transactionIndex: number,
  member: PublicKey,
  signers?: Keypair[],
  sendOptions?: SendOptions,
});
```

### spendingLimitUse

Use a spending limit.

```typescript
const signature = await multisig.rpc.spendingLimitUse({
  connection: Connection,
  feePayer: Keypair | Signer,
  multisigPda: PublicKey,
  member: Keypair | Signer,
  spendingLimit: PublicKey,
  mint: PublicKey,
  vaultIndex: number,
  amount: bigint,
  decimals: number,
  destination: PublicKey,
  tokenProgram?: PublicKey, // Token or Token2022
  memo?: string,
  sendOptions?: SendOptions,
});
```

---

## Account Types (multisig.accounts)

### Multisig

```typescript
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection,
  multisigPda
);

// Properties
multisigAccount.createKey // PublicKey
multisigAccount.configAuthority // PublicKey
multisigAccount.threshold // number
multisigAccount.timeLock // number
multisigAccount.transactionIndex // bigint
multisigAccount.staleTransactionIndex // bigint
multisigAccount.rentCollector // PublicKey | null
multisigAccount.bump // number
multisigAccount.members // Member[]
```

### Proposal

```typescript
const proposal = await multisig.accounts.Proposal.fromAccountAddress(
  connection,
  proposalPda
);

// Properties
proposal.multisig // PublicKey
proposal.transactionIndex // bigint
proposal.status // ProposalStatus
proposal.bump // number
proposal.approved // PublicKey[] - Members who approved
proposal.rejected // PublicKey[] - Members who rejected
proposal.cancelled // PublicKey[] - Members who cancelled
```

### VaultTransaction

```typescript
const vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(
  connection,
  transactionPda
);

// Properties
vaultTx.multisig // PublicKey
vaultTx.creator // PublicKey
vaultTx.index // bigint
vaultTx.bump // number
vaultTx.vaultIndex // number
vaultTx.vaultBump // number
vaultTx.ephemeralSignerBumps // number[]
vaultTx.message // CompiledMessage
```

### ConfigTransaction

```typescript
const configTx = await multisig.accounts.ConfigTransaction.fromAccountAddress(
  connection,
  transactionPda
);

// Properties
configTx.multisig // PublicKey
configTx.creator // PublicKey
configTx.index // bigint
configTx.bump // number
configTx.actions // ConfigAction[]
```

### Batch

```typescript
const batch = await multisig.accounts.Batch.fromAccountAddress(
  connection,
  batchPda
);

// Properties
batch.multisig // PublicKey
batch.creator // PublicKey
batch.index // bigint
batch.bump // number
batch.vaultIndex // number
batch.size // number
batch.executedTransactionIndex // number
```

### SpendingLimit

```typescript
const spendingLimit = await multisig.accounts.SpendingLimit.fromAccountAddress(
  connection,
  spendingLimitPda
);

// Properties
spendingLimit.multisig // PublicKey
spendingLimit.createKey // PublicKey
spendingLimit.vaultIndex // number
spendingLimit.mint // PublicKey
spendingLimit.amount // bigint
spendingLimit.period // Period
spendingLimit.remainingAmount // bigint
spendingLimit.lastReset // bigint
spendingLimit.bump // number
spendingLimit.members // PublicKey[]
spendingLimit.destinations // PublicKey[]
```

---

## Types (multisig.types)

### Permission

```typescript
enum Permission {
  Initiate = 1,
  Vote = 2,
  Execute = 4,
}
```

### Permissions

```typescript
class Permissions {
  static all(): Permissions;
  static fromPermissions(permissions: Permission[]): Permissions;
  has(permission: Permission): boolean;
}
```

### Member

```typescript
interface Member {
  key: PublicKey;
  permissions: Permissions;
}
```

### ProposalStatus

```typescript
type ProposalStatus =
  | { __kind: "Draft" }
  | { __kind: "Active"; timestamp: bigint }
  | { __kind: "Rejected"; timestamp: bigint }
  | { __kind: "Approved"; timestamp: bigint }
  | { __kind: "Executing" }
  | { __kind: "Executed"; timestamp: bigint }
  | { __kind: "Cancelled"; timestamp: bigint };
```

### ConfigAction

```typescript
type ConfigAction =
  | { __kind: "AddMember"; newMember: Member }
  | { __kind: "RemoveMember"; oldMember: PublicKey }
  | { __kind: "ChangeThreshold"; newThreshold: number }
  | { __kind: "SetTimeLock"; newTimeLock: number }
  | { __kind: "AddSpendingLimit"; ... }
  | { __kind: "RemoveSpendingLimit"; spendingLimit: PublicKey }
  | { __kind: "SetRentCollector"; newRentCollector: PublicKey | null };
```

### Period

```typescript
enum Period {
  OneTime = 0,
  Day = 1,
  Week = 2,
  Month = 3,
}
```

---

## Instructions Module (multisig.instructions)

The instructions module returns raw `TransactionInstruction` objects for custom transaction building.

```typescript
// Returns TransactionInstruction instead of sending
const ix = multisig.instructions.multisigCreateV2({
  createKey: createKeyPubkey,
  creator: creatorPubkey,
  multisigPda,
  configAuthority: null,
  threshold: 2,
  members: [...],
  timeLock: 0,
  rentCollector: null,
});

// Add to your own transaction
const tx = new Transaction().add(ix);
```

All RPC methods have corresponding instruction builders with the same parameters (minus connection and sendOptions).

---

## Transactions Module (multisig.transactions)

Returns `VersionedTransaction` objects.

```typescript
const versionedTx = await multisig.transactions.multisigCreateV2({
  connection,
  createKey,
  creator: creatorPubkey,
  multisigPda,
  configAuthority: null,
  threshold: 2,
  members: [...],
  timeLock: 0,
  rentCollector: null,
  feePayer: feePayerPubkey,
});

// Sign and send manually
versionedTx.sign([createKey, feePayer]);
const signature = await connection.sendTransaction(versionedTx);
```

---

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | NotAMember | Signer is not a member of the multisig |
| 6001 | Unauthorized | Member lacks required permissions |
| 6002 | InvalidThreshold | Threshold is invalid (must be 1-members.length) |
| 6003 | InvalidTransactionIndex | Transaction index is invalid |
| 6004 | StaleProposal | Proposal is stale and cannot be voted on |
| 6005 | ProposalNotApproved | Proposal has not reached threshold |
| 6006 | InvalidProposalStatus | Proposal is not in required status |
| 6007 | TimeLockNotSatisfied | Time lock period has not passed |
| 6008 | SpendingLimitExceeded | Spending limit exceeded |
| 6009 | InvalidSpendingLimitPeriod | Spending limit period invalid |
| 6010 | MemberAlreadyExists | Member already exists in multisig |
| 6011 | MemberNotFound | Member not found in multisig |
| 6012 | RemovingLastMember | Cannot remove the last member |
| 6013 | DecreasingThresholdBelowMembers | Threshold would exceed member count |

---

## Utils (multisig.utils)

```typescript
// Check if a member has a specific permission
const canVote = multisig.utils.memberHasPermission(
  member,
  Permission.Vote
);

// Get member from multisig by public key
const member = multisig.utils.getMember(
  multisigAccount,
  memberPubkey
);

// Check if proposal has reached threshold
const isApproved = multisig.utils.isProposalApproved(
  proposal,
  multisigAccount.threshold
);
```
