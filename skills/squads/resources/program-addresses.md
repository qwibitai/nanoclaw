# Squads Protocol Program Addresses

Complete reference for all Squads Protocol program addresses across networks.

## Program IDs

### Mainnet

| Program | Address | Description |
|---------|---------|-------------|
| Squads V4 Multisig | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | Main multisig program |
| Smart Account | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` | Account abstraction program |
| External Signature | `ExtSgUPtP3JyKUysFw2S5fpL5fWfUPzGUQLd2bTwftXN` | WebAuthn/passkey signatures |

### Devnet

| Program | Address | Description |
|---------|---------|-------------|
| Squads V4 Multisig | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | Same as mainnet |
| Smart Account | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` | Same as mainnet |
| External Signature | `ExtSgUPtP3JyKUysFw2S5fpL5fWfUPzGUQLd2bTwftXN` | Same as mainnet |

### Eclipse Mainnet

| Program | Address | Description |
|---------|---------|-------------|
| Squads V4 Multisig | `eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f` | Eclipse deployment |

### Legacy Programs (V3 - Archived)

| Program | Address | Description |
|---------|---------|-------------|
| Squads V3 | `SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu` | Archived, use V4 |
| Program Manager | `SMPLKTQhrgo22hFCVq2VGX1KAktTWjeizkhrdB1eauK` | Archived |

---

## PDA Seeds Reference

### Multisig PDA

```typescript
import * as multisig from "@sqds/multisig";
import { PublicKey } from "@solana/web3.js";

const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

// Seeds: ["multisig", createKey]
const [multisigPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("multisig"), createKey.toBuffer()],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [multisigPda] = multisig.getMultisigPda({
  createKey: createKeyPubkey,
});
```

### Vault PDA

```typescript
// Seeds: ["vault", multisig, index (u8)]
const [vaultPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    multisigPda.toBuffer(),
    new Uint8Array([vaultIndex]),
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [vaultPda] = multisig.getVaultPda({
  multisigPda,
  index: 0, // vault index
});
```

### Transaction PDA

```typescript
// Seeds: ["transaction", multisig, index (u64 LE)]
const indexBuffer = Buffer.alloc(8);
indexBuffer.writeBigUInt64LE(BigInt(transactionIndex));

const [transactionPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("transaction"),
    multisigPda.toBuffer(),
    indexBuffer,
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [transactionPda] = multisig.getTransactionPda({
  multisigPda,
  index: transactionIndex,
});
```

### Proposal PDA

```typescript
// Seeds: ["proposal", multisig, transactionIndex (u64 LE)]
const indexBuffer = Buffer.alloc(8);
indexBuffer.writeBigUInt64LE(BigInt(transactionIndex));

const [proposalPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("proposal"),
    multisigPda.toBuffer(),
    indexBuffer,
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [proposalPda] = multisig.getProposalPda({
  multisigPda,
  transactionIndex,
});
```

### Batch PDA

```typescript
// Seeds: ["batch", multisig, batchIndex (u64 LE)]
const indexBuffer = Buffer.alloc(8);
indexBuffer.writeBigUInt64LE(BigInt(batchIndex));

const [batchPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("batch"),
    multisigPda.toBuffer(),
    indexBuffer,
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [batchPda] = multisig.getBatchPda({
  multisigPda,
  batchIndex,
});
```

### Spending Limit PDA

```typescript
// Seeds: ["spending_limit", multisig, createKey]
const [spendingLimitPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("spending_limit"),
    multisigPda.toBuffer(),
    createKey.toBuffer(),
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [spendingLimitPda] = multisig.getSpendingLimitPda({
  multisigPda,
  createKey: spendingLimitCreateKey,
});
```

### Program Config PDA

```typescript
// Seeds: ["program_config"]
const [programConfigPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("program_config")],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [programConfigPda] = multisig.getProgramConfigPda({});
```

### Ephemeral Signer PDA

```typescript
// Seeds: ["ephemeral_signer", transaction, index (u8)]
const [ephemeralSignerPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("ephemeral_signer"),
    transactionPda.toBuffer(),
    new Uint8Array([ephemeralSignerIndex]),
  ],
  SQUADS_PROGRAM_ID
);

// Or use SDK helper
const [ephemeralSignerPda] = multisig.getEphemeralSignerPda({
  transactionPda,
  ephemeralSignerIndex: 0,
});
```

---

## External Program Dependencies

| Program | Address | Purpose |
|---------|---------|---------|
| System Program | `11111111111111111111111111111111` | Account creation, transfers |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL token operations |
| Token 2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token extensions |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | ATA creation |
| Memo Program | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Transaction memos |

---

## TypeScript Constants

```typescript
import { PublicKey } from "@solana/web3.js";

// Program IDs
export const SQUADS_V4_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
);

export const SMART_ACCOUNT_PROGRAM_ID = new PublicKey(
  "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG"
);

export const EXTERNAL_SIGNATURE_PROGRAM_ID = new PublicKey(
  "ExtSgUPtP3JyKUysFw2S5fpL5fWfUPzGUQLd2bTwftXN"
);

// Eclipse
export const SQUADS_V4_ECLIPSE_PROGRAM_ID = new PublicKey(
  "eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f"
);

// Legacy (V3 - archived)
export const SQUADS_V3_PROGRAM_ID = new PublicKey(
  "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu"
);

// PDA Seeds
export const MULTISIG_SEED = "multisig";
export const VAULT_SEED = "vault";
export const TRANSACTION_SEED = "transaction";
export const PROPOSAL_SEED = "proposal";
export const BATCH_SEED = "batch";
export const SPENDING_LIMIT_SEED = "spending_limit";
export const PROGRAM_CONFIG_SEED = "program_config";
export const EPHEMERAL_SIGNER_SEED = "ephemeral_signer";
```

---

## Verification

Verify the deployed program matches the audited source code:

```bash
# Install solana-verify tool
cargo install solana-verify

# Verify V4 Multisig on mainnet
solana-verify get-program-hash \
  -u https://api.mainnet-beta.solana.com \
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf

# Verify Smart Account on mainnet
solana-verify get-program-hash \
  -u https://api.mainnet-beta.solana.com \
  SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG
```

The hash should match the official audited build hash published by Squads.
