---
name: squads
creator: raunit-dev
description: Complete guide for Squads Protocol - Solana's leading smart account and multisig infrastructure. Covers Squads V4 Multisig for team treasury management, Smart Account Program for account abstraction and programmable wallets, and Grid for stablecoin rails and fintech infrastructure.
---

# Squads Protocol Development Guide

Squads Protocol is Solana's premier smart account infrastructure, securing over $10 billion in digital assets. This guide covers all three main products: Squads V4 Multisig, Smart Account Program, and Grid.

## Overview

Squads Protocol provides:

- **Squads V4 Multisig** - Multi-signature wallet for teams with proposals, voting, time locks, spending limits, and program upgrade management
- **Smart Account Program** - Account abstraction infrastructure with session keys, passkeys, programmable policies, and direct debits
- **Grid** - Open finance infrastructure for stablecoin rails, neobank platforms, and enterprise payment systems

## Program IDs

| Program | Mainnet | Devnet |
|---------|---------|--------|
| Squads V4 Multisig | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Smart Account | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` |
| External Signature (Grid) | `ExtSgUPtP3JyKUysFw2S5fpL5fWfUPzGUQLd2bTwftXN` | `ExtSgUPtP3JyKUysFw2S5fpL5fWfUPzGUQLd2bTwftXN` |

**Eclipse Mainnet:**
| Program | Address |
|---------|---------|
| Squads V4 Multisig | `eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f` |

## Quick Start

### Installation

```bash
# Squads V4 Multisig SDK
npm install @sqds/multisig @solana/web3.js

# Grid SDK
npm install @sqds/grid

# Grid React Native SDK
npm install @sqds/grid-react-native
```

### Basic Setup

```typescript
import * as multisig from "@sqds/multisig";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

// Setup connection
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Load wallet
const wallet = Keypair.fromSecretKey(/* your secret key */);

// Program ID constant
const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
```

---

## Squads V4 Multisig

Squads V4 is the latest version of the multisig protocol, featuring enhanced security, time locks, spending limits, and batch transactions.

### Core Concepts

**Multisig Account**: The main account that holds configuration (members, threshold, time lock settings).

**Vault**: A PDA controlled by the multisig where assets are stored. Each multisig can have multiple vaults (indexed 0, 1, 2...).

**Proposal**: A request to execute a transaction that requires approval from multisig members.

**Transaction**: The actual instruction(s) to be executed once a proposal is approved.

### Permission System

Members can have different permissions:

```typescript
import { Permission, Permissions } from "@sqds/multisig/lib/types";

// All permissions (can initiate, vote, and execute)
const fullPermissions = Permissions.all();

// Specific permissions
const voteOnly = Permissions.fromPermissions([Permission.Vote]);
const initiateAndVote = Permissions.fromPermissions([Permission.Initiate, Permission.Vote]);
const executeOnly = Permissions.fromPermissions([Permission.Execute]);
```

| Permission | Description |
|------------|-------------|
| `Initiate` | Can create new proposals |
| `Vote` | Can approve or reject proposals |
| `Execute` | Can execute approved proposals |

### Creating a Multisig

```typescript
import * as multisig from "@sqds/multisig";

const { Permissions } = multisig.types;

// Generate a unique create key (one-time use)
const createKey = Keypair.generate();

// Derive the multisig PDA
const [multisigPda] = multisig.getMultisigPda({
  createKey: createKey.publicKey,
});

// Create a 2-of-3 multisig
const signature = await multisig.rpc.multisigCreateV2({
  connection,
  createKey,
  creator: wallet,
  multisigPda,
  configAuthority: null, // Immutable config
  threshold: 2,
  members: [
    { key: member1.publicKey, permissions: Permissions.all() },
    { key: member2.publicKey, permissions: Permissions.all() },
    { key: member3.publicKey, permissions: Permissions.fromPermissions([Permission.Vote]) },
  ],
  timeLock: 0, // No time lock (in seconds)
  rentCollector: null,
});

console.log("Multisig created:", multisigPda.toString());
console.log("Transaction:", signature);
```

### Vault Operations

Vaults are PDAs that hold the multisig's assets:

```typescript
// Derive vault PDA (index 0 is the default vault)
const [vaultPda] = multisig.getVaultPda({
  multisigPda,
  index: 0,
});

console.log("Vault address:", vaultPda.toString());

// Check vault balance
const balance = await connection.getBalance(vaultPda);
console.log("Vault balance:", balance / 1e9, "SOL");
```

**Important**: Always send funds to the vault PDA, not the multisig account itself.

### Creating a Vault Transaction

```typescript
import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

// Get current transaction index
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection,
  multisigPda
);
const transactionIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);

// Derive transaction PDA
const [transactionPda] = multisig.getTransactionPda({
  multisigPda,
  index: transactionIndex,
});

// Create a transfer instruction
const transferIx = SystemProgram.transfer({
  fromPubkey: vaultPda,
  toPubkey: recipientPubkey,
  lamports: 0.1 * LAMPORTS_PER_SOL,
});

// Create the vault transaction
const signature = await multisig.rpc.vaultTransactionCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet.publicKey,
  vaultIndex: 0,
  ephemeralSigners: 0,
  transactionMessage: new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [transferIx],
  }),
});

console.log("Vault transaction created:", transactionPda.toString());
```

### Creating and Managing Proposals

```typescript
// Derive proposal PDA
const [proposalPda] = multisig.getProposalPda({
  multisigPda,
  transactionIndex,
});

// Create proposal for the transaction
const createProposalSig = await multisig.rpc.proposalCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet,
});

console.log("Proposal created:", proposalPda.toString());
```

### Voting on Proposals

```typescript
// Approve the proposal
const approveSig = await multisig.rpc.proposalApprove({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  member: wallet,
});

console.log("Proposal approved");

// Or reject the proposal
const rejectSig = await multisig.rpc.proposalReject({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  member: wallet,
  memo: "Reason for rejection",
});
```

### Executing Approved Transactions

```typescript
// Check if proposal is approved and ready
const proposal = await multisig.accounts.Proposal.fromAccountAddress(
  connection,
  proposalPda
);

if (proposal.status.__kind === "Approved") {
  // Execute the vault transaction
  const executeSig = await multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: wallet,
    multisigPda,
    transactionIndex,
    member: wallet.publicKey,
  });

  console.log("Transaction executed:", executeSig);
}
```

### Spending Limits

Spending limits allow members to execute transactions up to a certain amount without full multisig approval:

```typescript
// Create a spending limit
const createSpendingLimitSig = await multisig.rpc.configTransactionCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet.publicKey,
  actions: [{
    __kind: "AddSpendingLimit",
    createKey: spendingLimitCreateKey.publicKey,
    vaultIndex: 0,
    mint: SOL_MINT, // or token mint
    amount: BigInt(1 * LAMPORTS_PER_SOL), // 1 SOL
    period: multisig.types.Period.Day,
    members: [trustedMember.publicKey],
    destinations: [allowedDestination],
  }],
});

// Use spending limit (no proposal needed)
const useSpendingLimitSig = await multisig.rpc.spendingLimitUse({
  connection,
  feePayer: wallet,
  multisigPda,
  member: trustedMember,
  spendingLimit: spendingLimitPda,
  mint: SOL_MINT,
  vaultIndex: 0,
  amount: BigInt(0.5 * LAMPORTS_PER_SOL),
  decimals: 9,
  destination: allowedDestination,
});
```

### Batch Transactions

Execute multiple transactions atomically:

```typescript
// Create a batch
const [batchPda] = multisig.getBatchPda({
  multisigPda,
  batchIndex: transactionIndex,
});

const createBatchSig = await multisig.rpc.batchCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  batchIndex: transactionIndex,
  creator: wallet,
  vaultIndex: 0,
});

// Add transactions to the batch
await multisig.rpc.batchAddTransaction({
  connection,
  feePayer: wallet,
  multisigPda,
  batchIndex: transactionIndex,
  transactionIndex: 1,
  vaultIndex: 0,
  transactionMessage: /* first transaction */,
});

await multisig.rpc.batchAddTransaction({
  connection,
  feePayer: wallet,
  multisigPda,
  batchIndex: transactionIndex,
  transactionIndex: 2,
  vaultIndex: 0,
  transactionMessage: /* second transaction */,
});

// Create proposal and execute as usual
```

### Config Transactions

Modify multisig settings (requires proposal approval):

```typescript
// Add a new member
const addMemberSig = await multisig.rpc.configTransactionCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet.publicKey,
  actions: [{
    __kind: "AddMember",
    newMember: {
      key: newMemberPubkey,
      permissions: Permissions.all(),
    },
  }],
});

// Change threshold
const changeThresholdSig = await multisig.rpc.configTransactionCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet.publicKey,
  actions: [{
    __kind: "ChangeThreshold",
    newThreshold: 3,
  }],
});

// Remove a member
const removeMemberSig = await multisig.rpc.configTransactionCreate({
  connection,
  feePayer: wallet,
  multisigPda,
  transactionIndex,
  creator: wallet.publicKey,
  actions: [{
    __kind: "RemoveMember",
    oldMember: memberToRemove,
  }],
});
```

### Time Locks

Add a delay before approved transactions can execute:

```typescript
// Create multisig with time lock (1 day = 86400 seconds)
const signature = await multisig.rpc.multisigCreateV2({
  connection,
  createKey,
  creator: wallet,
  multisigPda,
  configAuthority: null,
  threshold: 2,
  members: [...],
  timeLock: 86400, // 1 day in seconds
  rentCollector: null,
});
```

### PDA Derivation Reference

```typescript
import * as multisig from "@sqds/multisig";

// Multisig PDA
const [multisigPda] = multisig.getMultisigPda({
  createKey: createKeyPubkey,
});

// Vault PDA
const [vaultPda] = multisig.getVaultPda({
  multisigPda,
  index: 0, // vault index
});

// Transaction PDA
const [transactionPda] = multisig.getTransactionPda({
  multisigPda,
  index: transactionIndex,
});

// Proposal PDA
const [proposalPda] = multisig.getProposalPda({
  multisigPda,
  transactionIndex,
});

// Batch PDA
const [batchPda] = multisig.getBatchPda({
  multisigPda,
  batchIndex,
});

// Spending Limit PDA
const [spendingLimitPda] = multisig.getSpendingLimitPda({
  multisigPda,
  createKey: spendingLimitCreateKey,
});

// Program Config PDA
const [programConfigPda] = multisig.getProgramConfigPda({});

// Ephemeral Signer PDA (for CPI calls)
const [ephemeralSignerPda] = multisig.getEphemeralSignerPda({
  transactionPda,
  ephemeralSignerIndex: 0,
});
```

---

## Smart Account Program

The Smart Account Program provides account abstraction features for Solana, enabling programmable wallets with session keys, passkeys, and policy-based execution.

### Core Concepts

**Smart Account**: A programmable wallet controlled by policies rather than just private keys.

**Session Key**: Temporary keys with limited permissions for specific operations.

**Passkey**: WebAuthn/FIDO2 authentication using biometrics or hardware keys.

**Policy**: Rules that govern what transactions can be executed.

### Features

- **Rent-free Deployment** - No rent required for smart accounts
- **Atomic Policy Enforcement** - All policy checks happen atomically
- **Account Compression** - Efficient storage for multiple signers
- **Extensible Policies** - Custom policy programs can be added
- **Direct Debits** - Automated recurring payments
- **Subscriptions** - Managed subscription billing

### REST API Base URL

```
https://developer-api.squads.so/api/v1
```

### Creating a Smart Account

```typescript
// Via REST API
const response = await fetch("https://developer-api.squads.so/api/v1/accounts", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    email: "user@example.com",
    // or
    signer: signerPublicKey,
  }),
});

const account = await response.json();
console.log("Smart account:", account.address);
```

### Session Key Management

Session keys allow delegated access with specific permissions:

```typescript
// Create a session key
const sessionResponse = await fetch(
  `https://developer-api.squads.so/api/v1/accounts/${accountId}/sessions`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      publicKey: sessionKeyPublicKey,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      permissions: ["transfer", "swap"],
      limits: {
        maxAmount: "1000000000", // 1 SOL in lamports
        dailyLimit: "5000000000", // 5 SOL daily
      },
    }),
  }
);
```

### Passkey Authentication

```typescript
// Register a passkey
const registerResponse = await fetch(
  `https://developer-api.squads.so/api/v1/accounts/${accountId}/passkeys`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      credentialId: webAuthnCredential.id,
      publicKey: webAuthnCredential.publicKey,
      attestation: webAuthnCredential.attestation,
    }),
  }
);

// Authenticate with passkey
const authResponse = await fetch(
  "https://developer-api.squads.so/api/v1/auth/passkey",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      credentialId: webAuthnCredential.id,
      assertion: webAuthnAssertion,
    }),
  }
);
```

### Policy Configuration

```typescript
// Set spending policy
const policyResponse = await fetch(
  `https://developer-api.squads.so/api/v1/accounts/${accountId}/policies`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      type: "spending_limit",
      params: {
        mint: "So11111111111111111111111111111111111111112", // SOL
        amount: "10000000000", // 10 SOL
        period: "daily",
      },
    }),
  }
);
```

---

## Grid

Grid is Squads' open finance infrastructure for stablecoin rails, enabling neobank platforms and enterprise payment systems.

### Features

- **Stablecoin Rails** - USDC/USDT payment infrastructure
- **Programmable Payments** - Automated money flows
- **Virtual Accounts** - Fiat on/off ramps
- **KYC Integration** - Built-in compliance tools
- **Self-Custody** - Users maintain control of assets

### API Authentication

```typescript
// Email OTP authentication
const otpResponse = await fetch("https://developer-api.squads.so/api/v1/auth/email/otp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "user@example.com",
  }),
});

// Verify OTP
const verifyResponse = await fetch("https://developer-api.squads.so/api/v1/auth/email/verify", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "user@example.com",
    otp: "123456",
  }),
});

const { accessToken } = await verifyResponse.json();
```

### Account Management

```typescript
// Get account details
const accountResponse = await fetch(
  `https://developer-api.squads.so/api/v1/accounts/${accountId}`,
  {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
  }
);

const account = await accountResponse.json();
console.log("Balance:", account.balance);
console.log("Status:", account.status);
```

### Payment Operations

```typescript
// Create a payment intent
const paymentResponse = await fetch(
  "https://developer-api.squads.so/api/v1/payments",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      amount: "100000000", // 100 USDC (6 decimals)
      currency: "USDC",
      recipient: recipientAddress,
      memo: "Payment for services",
    }),
  }
);

const payment = await paymentResponse.json();
console.log("Payment ID:", payment.id);
console.log("Status:", payment.status);
```

### Standing Orders (Recurring Payments)

```typescript
// Create a standing order
const standingOrderResponse = await fetch(
  "https://developer-api.squads.so/api/v1/standing-orders",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      amount: "50000000", // 50 USDC
      currency: "USDC",
      recipient: recipientAddress,
      frequency: "monthly",
      startDate: "2024-02-01",
      memo: "Monthly subscription",
    }),
  }
);
```

### Spending Limits

```typescript
// Set spending limit
const limitResponse = await fetch(
  `https://developer-api.squads.so/api/v1/accounts/${accountId}/limits`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      type: "daily",
      amount: "1000000000", // 1000 USDC
      currency: "USDC",
    }),
  }
);
```

---

## Best Practices

### Security

1. **Never share private keys** - Use environment variables for sensitive data
2. **Verify program IDs** - Always confirm you're interacting with official programs
3. **Use time locks** - For high-value treasuries, add time locks for additional security
4. **Limit permissions** - Give members only the permissions they need
5. **Test on devnet** - Always test transactions on devnet before mainnet

### Transaction Optimization

1. **Use Address Lookup Tables** - Reduce transaction size for complex operations
2. **Batch transactions** - Group related operations when possible
3. **Set appropriate compute budget** - Avoid transaction failures due to compute limits

```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

// Add compute budget instruction
const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400_000,
});

// Add priority fee for faster inclusion
const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: 10_000,
});
```

### Error Handling

```typescript
try {
  const signature = await multisig.rpc.proposalCreate({
    connection,
    feePayer: wallet,
    multisigPda,
    transactionIndex,
    creator: wallet,
  });
} catch (error) {
  if (error.message.includes("NotAMember")) {
    console.error("Wallet is not a member of this multisig");
  } else if (error.message.includes("Unauthorized")) {
    console.error("Wallet does not have required permissions");
  } else if (error.message.includes("InvalidTransactionIndex")) {
    console.error("Transaction index already used");
  } else {
    throw error;
  }
}
```

### Fetching Account State

```typescript
// Get multisig account
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection,
  multisigPda
);

console.log("Threshold:", multisigAccount.threshold);
console.log("Members:", multisigAccount.members);
console.log("Transaction Index:", multisigAccount.transactionIndex.toString());

// Get proposal status
const proposal = await multisig.accounts.Proposal.fromAccountAddress(
  connection,
  proposalPda
);

console.log("Status:", proposal.status.__kind);
console.log("Approved:", proposal.approved.length);
console.log("Rejected:", proposal.rejected.length);
```

---

## Common Patterns

### Program Upgrade Multisig

Secure program upgrade authority with a multisig:

```typescript
// Transfer upgrade authority to multisig vault
const transferAuthIx = createSetAuthorityInstruction(
  programDataAddress,
  currentAuthority,
  AuthorityType.UpgradeAuthority,
  vaultPda
);

// Execute via multisig proposal
// Now program upgrades require multisig approval
```

### Treasury Management

```typescript
// Create multiple vaults for different purposes
const [operationsVault] = multisig.getVaultPda({ multisigPda, index: 0 });
const [reserveVault] = multisig.getVaultPda({ multisigPda, index: 1 });
const [grantVault] = multisig.getVaultPda({ multisigPda, index: 2 });

// Set spending limits for operations vault
// Reserve vault requires full multisig approval
```

### Validator Operations

```typescript
// Manage validator identity and vote account with multisig
// Transfer validator identity to vault
// Set up spending limits for operational costs
```

---

## Resources

### Official Documentation
- [Squads Documentation](https://docs.squads.so)
- [V4 TypeDoc](https://v4-sdk-typedoc.vercel.app)
- [Grid Developer Portal](https://developers.squads.so)

### GitHub Repositories
- [Squads V4](https://github.com/Squads-Protocol/v4)
- [Smart Account Program](https://github.com/Squads-Protocol/smart-account-program)
- [V4 Examples](https://github.com/Squads-Protocol/v4-examples)
- [Grid Organization](https://github.com/squads-grid)
- [Public V4 Client](https://github.com/Squads-Protocol/public-v4-client)

### Security Audits
- OtterSec audit
- Neodyme audit
- Certora audit
- Trail of Bits audit

### Verify Program Builds

```bash
# Install solana-verify
cargo install solana-verify

# Verify Squads V4 program
solana-verify get-program-hash -u mainnet-beta SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
```

---

## Skill Structure

```
squads/
├── SKILL.md                              # This file
├── resources/
│   ├── program-addresses.md              # All program IDs and PDAs
│   ├── multisig-api-reference.md         # @sqds/multisig SDK reference
│   ├── smart-account-api-reference.md    # Smart Account API reference
│   └── grid-api-reference.md             # Grid REST API reference
├── examples/
│   ├── multisig/
│   │   ├── create-multisig.ts            # Create multisig with members
│   │   ├── proposals-voting.ts           # Proposals and voting
│   │   ├── vault-transactions.ts         # Vault operations
│   │   └── spending-limits.ts            # Spending limit management
│   ├── smart-account/
│   │   ├── account-creation.ts           # Smart account setup
│   │   └── session-keys.ts               # Session key management
│   └── grid/
│       ├── api-quickstart.ts             # REST API basics
│       └── payments.ts                   # Payment operations
├── templates/
│   ├── multisig-setup.ts                 # Multisig client template
│   ├── smart-account-setup.ts            # Smart account template
│   └── grid-client.ts                    # Grid API client template
└── docs/
    └── troubleshooting.md                # Common issues and solutions
```
