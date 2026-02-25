# deBridge Solana SDK API Reference

Complete reference for all SDK functions, types, and modules.

## Module: `sending`

Core module for sending cross-chain transfers.

### Structs

#### `SendIx`

Main instruction struct for sending tokens across chains.

```rust
pub struct SendIx {
    pub target_chain_id: [u8; 32],           // Destination chain identifier
    pub receiver: Vec<u8>,                   // Recipient address (EVM: 20 bytes, Solana: 32 bytes)
    pub is_use_asset_fee: bool,              // true = pay fees in bridged token
    pub amount: u64,                         // Amount to send (in token decimals)
    pub submission_params: Option<SendSubmissionParamsInput>,
    pub referral_code: Option<u32>,          // Optional referral tracking code
}
```

#### `SendSubmissionParamsInput`

Configuration for advanced sending scenarios.

```rust
pub struct SendSubmissionParamsInput {
    pub execution_fee: u64,                  // Reward for executor on destination
    pub flags: [u8; 32],                     // Protocol feature flags
    pub fallback_address: Vec<u8>,           // Fallback recipient if execution fails
    pub external_call_shortcut: [u8; 32],    // Keccak256 hash of external call data
}
```

#### `InitExternalCallIx`

Manages large external call buffers.

```rust
pub struct InitExternalCallIx {
    pub external_call_len: u32,              // Buffer size
    pub chain_id: [u8; 32],                  // Target chain
    pub external_call_shortcut: [u8; 32],    // Content hash (Keccak256)
    pub external_call: Vec<u8>,              // Actual call data
}
```

### Invocation Functions

| Function | Description | Returns |
|----------|-------------|---------|
| `invoke_debridge_send(ix: SendIx, accounts: &[AccountInfo])` | Standard token sending | `Result<()>` |
| `invoke_debridge_send_signed(ix: SendIx, accounts: &[AccountInfo], seeds: &[&[&[u8]]])` | PDA-based sender authorization | `Result<()>` |
| `invoke_init_external_call(ix: InitExternalCallIx, accounts: &[AccountInfo])` | External call buffer initialization | `Result<()>` |
| `invoke_init_external_call_signed(ix: InitExternalCallIx, accounts: &[AccountInfo], seeds: &[&[&[u8]]])` | Signed variant for PDAs | `Result<()>` |
| `invoke_send_message(ix: SendIx, accounts: &[AccountInfo])` | Zero-amount messaging | `Result<()>` |
| `invoke_send_message_signed(ix: SendIx, accounts: &[AccountInfo], seeds: &[&[&[u8]]])` | Authorized messaging | `Result<()>` |

### Query Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `get_state` | `accounts: &[AccountInfo]` | `Result<State>` | Get protocol state |
| `get_chain_support_info` | `chain_id: &[u8; 32], accounts` | `Result<ChainSupportInfo>` | Get chain config |
| `get_asset_fee_info` | `bridge: &Pubkey, chain_id: &[u8; 32], accounts` | `Result<AssetFeeInfo>` | Get asset fee config |
| `is_chain_supported` | `chain_id: &[u8; 32], accounts` | `Result<bool>` | Check chain availability |

### Fee Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `get_transfer_fee` | `accounts: &[AccountInfo]` | `Result<u64>` | Get base transfer fee (BPS) |
| `get_transfer_fee_for_chain` | `chain_id: &[u8; 32], accounts` | `Result<u64>` | Get chain-specific fee |
| `get_chain_native_fix_fee` | `chain_id: &[u8; 32], accounts` | `Result<u64>` | Get fixed native fee |
| `get_default_native_fix_fee` | `accounts: &[AccountInfo]` | `Result<u64>` | Get default native fee |
| `is_asset_fee_available` | `chain_id: &[u8; 32], accounts` | `Result<bool>` | Check asset fee support |
| `try_get_chain_asset_fix_fee` | `chain_id: &[u8; 32], accounts` | `Result<Option<u64>>` | Get asset fee if available |
| `add_transfer_fee` | `amount: u64, accounts` | `Result<u64>` | Add transfer fee to amount |
| `add_all_fees` | `amount: u64, chain_id: &[u8; 32], accounts` | `Result<u64>` | Add all fees to amount |

## Module: `check_claiming`

Validation module for receiving cross-chain claims.

### Structs

#### `ValidatedExecuteExtCallIx`

Wraps instruction for claim validation.

```rust
impl ValidatedExecuteExtCallIx {
    // Create from current instruction
    pub fn try_from_current_ix() -> Result<Self>;

    // Get submission account pubkey (index 5)
    pub fn get_submission_key(&self) -> Result<Pubkey>;

    // Get submission authority pubkey (index 6)
    pub fn get_submission_auth(&self) -> Result<Pubkey>;

    // Validate submission authority
    pub fn validate_submission_auth(&self, candidate: &Pubkey) -> Result<()>;

    // Comprehensive validation
    pub fn validate_submission_account(
        &self,
        account: &AccountInfo,
        validation: &SubmissionAccountValidation,
    ) -> Result<()>;
}
```

#### `SubmissionAccountValidation`

Builder for validation parameters.

```rust
pub struct SubmissionAccountValidation {
    pub claimer_validation: Option<Pubkey>,
    pub receiver_validation: Option<Pubkey>,
    pub fallback_address_validation: Option<Vec<u8>>,
    pub token_mint_validation: Option<Pubkey>,
    pub native_sender_validation: Option<Vec<u8>>,
    pub source_chain_id_validation: Option<[u8; 32]>,
}

impl Default for SubmissionAccountValidation {
    fn default() -> Self {
        Self {
            claimer_validation: None,
            receiver_validation: None,
            fallback_address_validation: None,
            token_mint_validation: None,
            native_sender_validation: None,
            source_chain_id_validation: None,
        }
    }
}
```

### Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `get_current_instruction_program_id()` | `Result<Pubkey>` | Get current executing program ID |

## Module: `keys`

PDA derivation utilities.

### Traits

#### `BridgePubkey`

```rust
impl BridgePubkey for Pubkey {
    // Find bridge PDA for token mint
    fn find_bridge_address(token_mint: &Pubkey) -> (Pubkey, u8);

    // Create with known bump
    fn create_bridge_address(token_mint: &Pubkey, bump: u8) -> Result<Pubkey>;
}
```

#### `ChainSupportInfoPubkey`

```rust
impl ChainSupportInfoPubkey for Pubkey {
    // Find chain support info PDA
    fn find_chain_support_info_address(chain_id: &[u8; 32]) -> (Pubkey, u8);

    // Create with known bump
    fn create_chain_support_info_address(chain_id: &[u8; 32], bump: u8) -> Result<Pubkey>;
}
```

#### `AssetFeeInfoPubkey`

```rust
impl AssetFeeInfoPubkey for Pubkey {
    // Find asset fee info PDA
    fn find_asset_fee_info_address(
        bridge: &Pubkey,
        chain_id: &[u8; 32]
    ) -> (Pubkey, u8);

    // Create with known bump
    fn create_asset_fee_info_address(
        bridge: &Pubkey,
        chain_id: &[u8; 32],
        bump: u8
    ) -> Result<Pubkey>;

    // Default bridge fee address
    fn default_bridge_fee_address() -> Pubkey;
}
```

#### `ExternalCallStoragePubkey`

```rust
impl ExternalCallStoragePubkey for Pubkey {
    // Find external call storage PDA
    fn find_external_call_storage_address(
        shortcut: &[u8; 32],
        owner: &Pubkey
    ) -> (Pubkey, u8);

    // Create with known bump
    fn create_external_call_storage_address(
        shortcut: &[u8; 32],
        owner: &Pubkey,
        bump: u8
    ) -> Result<Pubkey>;
}
```

#### `ExternalCallMetaPubkey`

```rust
impl ExternalCallMetaPubkey for Pubkey {
    // Find external call meta PDA
    fn find_external_call_meta_address(storage: &Pubkey) -> (Pubkey, u8);

    // Create with known bump
    fn create_external_call_meta_address(storage: &Pubkey, bump: u8) -> Result<Pubkey>;
}
```

## Module: `flags`

Protocol feature flags.

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `UNWRAP_ETH` | `0` | Unwrap to native ETH on destination |
| `REVERT_IF_EXTERNAL_FAIL` | `1` | Revert if external call fails |
| `PROXY_WITH_SENDER` | `2` | Include sender in proxy call |
| `SEND_HASHED_DATA` | `3` | Send data as hash |
| `DIRECT_WALLET_FLOW` | `31` | Use direct wallet flow |

### Traits

#### `SetReservedFlag`

```rust
pub trait SetReservedFlag {
    fn set_reserved_flag(&mut self, flag: u8);
}

impl SetReservedFlag for [u8; 32] {
    fn set_reserved_flag(&mut self, flag: u8) {
        self[31 - flag as usize / 8] |= 1 << (flag % 8);
    }
}
```

#### `CheckReservedFlag`

```rust
pub trait CheckReservedFlag {
    fn is_flag_set(&self, flag: u8) -> bool;
}

impl CheckReservedFlag for [u8; 32] {
    fn is_flag_set(&self, flag: u8) -> bool {
        (self[31 - flag as usize / 8] & (1 << (flag % 8))) != 0
    }
}

impl CheckReservedFlag for SendSubmissionParamsInput {
    fn is_flag_set(&self, flag: u8) -> bool {
        self.flags.is_flag_set(flag)
    }
}
```

## Module: `hash`

Hashing utilities.

### Types

#### `HashAdapter`

Trait for Keccak256 hashing.

```rust
pub trait HashAdapter {
    fn keccak256(data: &[u8]) -> [u8; 32];
}
```

#### `SolanaKeccak256`

Solana-compatible Keccak256 implementation.

```rust
pub struct SolanaKeccak256;

impl HashAdapter for SolanaKeccak256 {
    fn keccak256(data: &[u8]) -> [u8; 32] {
        solana_program::keccak::hash(data).to_bytes()
    }
}
```

## Module: `debridge_accounts`

Account state types.

### State Types

```rust
pub struct State {
    pub is_initialized: bool,
    pub admin: Pubkey,
    pub native_fee: u64,
    pub transfer_fee_bps: u64,
    // ... additional fields
}

pub struct ChainSupportInfo {
    pub is_enabled: bool,
    pub fixed_native_fee: u64,
    pub transfer_fee_bps: u64,
    // ... additional fields
}

pub struct AssetFeeInfo {
    pub is_enabled: bool,
    pub fixed_fee: u64,
    // ... additional fields
}
```

## Constants

### Program IDs

```rust
// Main deBridge program (sending/claiming)
pub const DEBRIDGE_ID: Pubkey = pubkey!("DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh");

// Settings and configuration program
pub const SETTINGS_ID: Pubkey = pubkey!("DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft");

// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10000;

// Solana chain ID
pub const SOLANA_CHAIN_ID: [u8; 32] = /* ASCII: "sol" at end */;
```

## Required Accounts Order

When calling `invoke_debridge_send`, accounts must be in this order:

| Index | Account | Signer | Writable |
|-------|---------|--------|----------|
| 0 | Bridge | No | Yes |
| 1 | Token Mint | No | No |
| 2 | Staking Wallet | No | Yes |
| 3 | Mint Authority | No | No |
| 4 | Chain Support Info | No | No |
| 5 | Settings Program | No | No |
| 6 | SPL Token Program | No | No |
| 7 | State | No | No |
| 8 | deBridge Program | No | No |
| 9 | Nonce Storage | No | Yes |
| 10 | Sender | Yes | Yes |
| 11 | Sender Wallet | No | Yes |
| 12 | Send From Wallet | No | Yes |
| 13-17 | Additional | Varies | Varies |

## Prelude Module

Convenience re-exports:

```rust
pub use super::{
    chain_ids,
    check_claiming as debridge_check_claiming,
    sending as debridge_sending,
    DEBRIDGE_ID,
    SETTINGS_ID,
    SOLANA_CHAIN_ID,
};
```

Use with:

```rust
use debridge_solana_sdk::prelude::*;
```
