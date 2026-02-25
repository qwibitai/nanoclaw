# deBridge Program IDs and PDAs

Reference for all deBridge program addresses and PDA derivation.

## Program IDs

### Mainnet Production

```rust
use debridge_solana_sdk::{DEBRIDGE_ID, SETTINGS_ID};

// Main deBridge Program - Handles sending and claiming
pub const DEBRIDGE_ID: Pubkey = pubkey!("DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh");

// Settings Program - Stores configuration and confirmations
pub const SETTINGS_ID: Pubkey = pubkey!("DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft");
```

### TypeScript

```typescript
import { PublicKey } from '@solana/web3.js';

export const DEBRIDGE_PROGRAM_ID = new PublicKey(
  'DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh'
);

export const SETTINGS_PROGRAM_ID = new PublicKey(
  'DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft'
);
```

## PDA Seeds Reference

### Bridge Account

Stores bridge configuration for a specific token mint.

```rust
// Seeds: ["BRIDGE", token_mint]
// Program: DEBRIDGE_ID

use debridge_solana_sdk::keys::BridgePubkey;

let (bridge_pda, bump) = Pubkey::find_bridge_address(&token_mint);

// With known bump
let bridge_pda = Pubkey::create_bridge_address(&token_mint, bump)?;
```

**TypeScript:**

```typescript
const [bridgePda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('BRIDGE'), tokenMint.toBuffer()],
  DEBRIDGE_PROGRAM_ID
);
```

### State Account

Protocol-wide state configuration.

```rust
// Seeds: ["STATE"]
// Program: DEBRIDGE_ID

let (state_pda, bump) = Pubkey::find_program_address(
    &[b"STATE"],
    &DEBRIDGE_ID,
);
```

**TypeScript:**

```typescript
const [statePda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('STATE')],
  DEBRIDGE_PROGRAM_ID
);
```

### Chain Support Info

Chain-specific configuration and fees.

```rust
// Seeds: ["CHAIN_SUPPORT_INFO", chain_id]
// Program: SETTINGS_ID

use debridge_solana_sdk::keys::ChainSupportInfoPubkey;

let (chain_info_pda, bump) = Pubkey::find_chain_support_info_address(
    &target_chain_id,
);

// With known bump
let chain_info_pda = Pubkey::create_chain_support_info_address(
    &target_chain_id,
    bump,
)?;
```

**TypeScript:**

```typescript
const [chainSupportInfoPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('CHAIN_SUPPORT_INFO'), targetChainId],
  SETTINGS_PROGRAM_ID
);
```

### Asset Fee Info

Asset-specific fee configuration for a chain.

```rust
// Seeds: ["ASSET_FEE_INFO", bridge_pubkey, chain_id]
// Program: SETTINGS_ID

use debridge_solana_sdk::keys::AssetFeeInfoPubkey;

let (asset_fee_pda, bump) = Pubkey::find_asset_fee_info_address(
    &bridge_pubkey,
    &target_chain_id,
);

// Default bridge fee address
let default_fee = Pubkey::default_bridge_fee_address();
```

**TypeScript:**

```typescript
const [assetFeeInfoPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('ASSET_FEE_INFO'),
    bridgePubkey.toBuffer(),
    targetChainId,
  ],
  SETTINGS_PROGRAM_ID
);
```

### External Call Storage

Stores external call data for large payloads.

```rust
// Seeds: ["EXTERNAL_CALL_STORAGE", shortcut, owner, SOLANA_CHAIN_ID]
// Program: DEBRIDGE_ID

use debridge_solana_sdk::keys::ExternalCallStoragePubkey;

let (storage_pda, bump) = Pubkey::find_external_call_storage_address(
    &shortcut,  // Keccak256 hash of call data
    &owner,
);
```

**TypeScript:**

```typescript
const [externalCallStoragePda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('EXTERNAL_CALL_STORAGE'),
    shortcut,
    owner.toBuffer(),
    SOLANA_CHAIN_ID,
  ],
  DEBRIDGE_PROGRAM_ID
);
```

### External Call Meta

Metadata for external call storage.

```rust
// Seeds: ["EXTERNAL_CALL_META", storage_account]
// Program: DEBRIDGE_ID

use debridge_solana_sdk::keys::ExternalCallMetaPubkey;

let (meta_pda, bump) = Pubkey::find_external_call_meta_address(
    &storage_account,
);
```

**TypeScript:**

```typescript
const [externalCallMetaPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('EXTERNAL_CALL_META'), storageAccount.toBuffer()],
  DEBRIDGE_PROGRAM_ID
);
```

### Nonce Storage

Tracks send nonces for ordering.

```rust
// Seeds: ["NONCE_STORAGE", sender]
// Program: DEBRIDGE_ID

let (nonce_storage_pda, bump) = Pubkey::find_program_address(
    &[b"NONCE_STORAGE", sender.as_ref()],
    &DEBRIDGE_ID,
);
```

**TypeScript:**

```typescript
const [nonceStoragePda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('NONCE_STORAGE'), sender.toBuffer()],
  DEBRIDGE_PROGRAM_ID
);
```

### Submission Account

Represents a cross-chain submission.

```rust
// Seeds: ["SUBMISSION", submission_id]
// Program: DEBRIDGE_ID

let (submission_pda, bump) = Pubkey::find_program_address(
    &[b"SUBMISSION", &submission_id],
    &DEBRIDGE_ID,
);
```

## Complete Account Setup Example

```rust
use anchor_lang::prelude::*;
use debridge_solana_sdk::prelude::*;
use debridge_solana_sdk::keys::*;

pub fn derive_all_accounts(
    token_mint: &Pubkey,
    sender: &Pubkey,
    target_chain_id: &[u8; 32],
) -> AllDeBridgeAccounts {
    // Bridge account
    let (bridge, bridge_bump) = Pubkey::find_bridge_address(token_mint);

    // State account
    let (state, state_bump) = Pubkey::find_program_address(
        &[b"STATE"],
        &DEBRIDGE_ID,
    );

    // Chain support info
    let (chain_support_info, csi_bump) =
        Pubkey::find_chain_support_info_address(target_chain_id);

    // Asset fee info
    let (asset_fee_info, afi_bump) =
        Pubkey::find_asset_fee_info_address(&bridge, target_chain_id);

    // Nonce storage
    let (nonce_storage, ns_bump) = Pubkey::find_program_address(
        &[b"NONCE_STORAGE", sender.as_ref()],
        &DEBRIDGE_ID,
    );

    AllDeBridgeAccounts {
        bridge,
        state,
        chain_support_info,
        asset_fee_info,
        nonce_storage,
        debridge_program: DEBRIDGE_ID,
        settings_program: SETTINGS_ID,
    }
}

pub struct AllDeBridgeAccounts {
    pub bridge: Pubkey,
    pub state: Pubkey,
    pub chain_support_info: Pubkey,
    pub asset_fee_info: Pubkey,
    pub nonce_storage: Pubkey,
    pub debridge_program: Pubkey,
    pub settings_program: Pubkey,
}
```

## TypeScript Complete Setup

```typescript
import { PublicKey } from '@solana/web3.js';

export function deriveDeBridgeAccounts(
  tokenMint: PublicKey,
  sender: PublicKey,
  targetChainId: Uint8Array,
) {
  const [bridge] = PublicKey.findProgramAddressSync(
    [Buffer.from('BRIDGE'), tokenMint.toBuffer()],
    DEBRIDGE_PROGRAM_ID
  );

  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('STATE')],
    DEBRIDGE_PROGRAM_ID
  );

  const [chainSupportInfo] = PublicKey.findProgramAddressSync(
    [Buffer.from('CHAIN_SUPPORT_INFO'), targetChainId],
    SETTINGS_PROGRAM_ID
  );

  const [assetFeeInfo] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('ASSET_FEE_INFO'),
      bridge.toBuffer(),
      targetChainId,
    ],
    SETTINGS_PROGRAM_ID
  );

  const [nonceStorage] = PublicKey.findProgramAddressSync(
    [Buffer.from('NONCE_STORAGE'), sender.toBuffer()],
    DEBRIDGE_PROGRAM_ID
  );

  return {
    bridge,
    state,
    chainSupportInfo,
    assetFeeInfo,
    nonceStorage,
    debridgeProgram: DEBRIDGE_PROGRAM_ID,
    settingsProgram: SETTINGS_PROGRAM_ID,
  };
}
```

## Custom Environment Setup

For devnet/testnet, use environment variables:

```toml
# Cargo.toml
[dependencies]
debridge-solana-sdk = { git = "...", features = ["env"] }
```

Set environment variables:

```bash
export DEBRIDGE_PROGRAM_PUBKEY="CustomDebridgeProgramId..."
export DEBRIDGE_SETTINGS_PROGRAM_PUBKEY="CustomSettingsProgramId..."
```

Note: `prod` and `env` features are mutually exclusive.
