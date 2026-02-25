# SDK: Squads Multisig Integration

When a GLAM vault is owned by a Squads multisig, all vault operations go through Squads proposal approval.

## Setup

```typescript
import { GlamClient, getProgramAndBitflagByProtocolName } from "@glamsystems/glam-sdk";
import * as multisig from "@sqds/multisig";
import { Connection, PublicKey, TransactionMessage } from "@solana/web3.js";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const wallet = new NodeWallet(memberKeypair);
const glamClient = new GlamClient({ wallet });

const multisigPda = new PublicKey("YourMultisigPda...");
const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
```

## Building GLAM Operations Through Squads

### Step 1: Build GLAM Instruction

Use SDK `txBuilder` methods to get raw instructions without sending:

```typescript
// Example: Enable JupiterSwap integration
const permissionsMap = getProgramAndBitflagByProtocolName();
const [jupiterProgram, jupiterBitflag] = permissionsMap["JupiterSwap"];

const ix = await glamClient.access.txBuilder.enableDisableProtocolsIx(
  jupiterProgram,
  parseInt(jupiterBitflag, 2),
  true, // enable
  memberKeypair.publicKey
);
```

### Step 2: Wrap in Squads Proposal

```typescript
// Get current transaction index
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection, multisigPda
);
const transactionIndex = Number(multisigAccount.transactionIndex) + 1;

// Create vault transaction
const [transactionPda] = multisig.getTransactionPda({
  multisigPda,
  index: BigInt(transactionIndex),
});

const message = new TransactionMessage({
  payerKey: vaultPda,
  recentBlockhash: (await glamClient.blockhashWithCache.get()).blockhash,
  instructions: [ix],
});

const createTx = multisig.instructions.vaultTransactionCreate({
  multisigPda,
  transactionIndex: BigInt(transactionIndex),
  creator: memberKeypair.publicKey,
  vaultIndex: 0,
  ephemeralSigners: 0,
  transactionMessage: message,
});

// Create and execute proposal
const proposalTx = multisig.instructions.proposalCreate({
  multisigPda,
  transactionIndex: BigInt(transactionIndex),
  creator: memberKeypair.publicKey,
});

const approveTx = multisig.instructions.proposalApprove({
  multisigPda,
  transactionIndex: BigInt(transactionIndex),
  member: memberKeypair.publicKey,
});
```

### Step 3: Send Transaction

```typescript
const tx = new Transaction().add(createTx, proposalTx, approveTx);
const vTx = await glamClient.intoVersionedTransaction(tx);
const txSig = await glamClient.sendAndConfirm(vTx);
```

## Supported Operations

Any GLAM operation with a `txBuilder` method can be wrapped in a Squads proposal:

- `access.txBuilder.enableDisableProtocolsIx()` - Enable/disable integrations
- `access.txBuilder.grantDelegatePermissionsIx()` - Grant delegate permissions
- `access.txBuilder.setProtocolPolicyIx()` - Set policies
- All other sub-client `txBuilder` methods

## Key Helpers

| Helper | Description |
|--------|-------------|
| `glamClient.blockhashWithCache` | Cached blockhash for transaction messages |
| `glamClient.intoVersionedTransaction(tx)` | Convert to versioned transaction |
| `glamClient.sendAndConfirm(vTx)` | Send and confirm transaction |
| `getProgramAndBitflagByProtocolName()` | Map protocol names to program + bitflag |
