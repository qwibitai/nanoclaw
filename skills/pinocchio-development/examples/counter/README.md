# Pinocchio Counter Example

A minimal counter program demonstrating core Pinocchio patterns: account validation, PDA derivation, and state management.

## Program Overview

- **Initialize**: Create a counter PDA for a user
- **Increment**: Add 1 to the counter
- **Decrement**: Subtract 1 from the counter
- **Reset**: Set counter back to 0

## Project Structure

```
counter/
├── Cargo.toml
├── src/
│   ├── lib.rs           # Entrypoint + instruction routing
│   ├── state.rs         # Account definitions
│   ├── instructions/
│   │   ├── mod.rs
│   │   ├── initialize.rs
│   │   ├── increment.rs
│   │   ├── decrement.rs
│   │   └── reset.rs
│   └── error.rs         # Custom errors
└── tests/
    └── counter.rs
```

## Cargo.toml

```toml
[package]
name = "counter"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[features]
default = []
bpf-entrypoint = []

[dependencies]
pinocchio = "0.10"
pinocchio-system = "0.4"
bytemuck = { version = "1.14", features = ["derive"] }
shank = "0.4"

[dev-dependencies]
solana-program-test = "2.0"
solana-sdk = "2.0"
tokio = { version = "1", features = ["full"] }
```

## src/lib.rs

```rust
#![cfg_attr(not(test), no_std)]

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub mod error;
pub mod instructions;
pub mod state;

// Program ID - replace with your deployed address
pinocchio::declare_id!("Counter11111111111111111111111111111111111");

// Instruction discriminators
pub const INITIALIZE: u8 = 0;
pub const INCREMENT: u8 = 1;
pub const DECREMENT: u8 = 2;
pub const RESET: u8 = 3;

#[cfg(feature = "bpf-entrypoint")]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Verify program ID
    if program_id != &crate::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Route by first byte discriminator
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        &INITIALIZE => instructions::initialize::process(program_id, accounts, data),
        &INCREMENT => instructions::increment::process(program_id, accounts),
        &DECREMENT => instructions::decrement::process(program_id, accounts),
        &RESET => instructions::reset::process(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

## src/state.rs

```rust
use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

/// Account discriminator for Counter
pub const COUNTER_DISCRIMINATOR: u8 = 1;

/// Counter account structure
/// Size: 1 + 32 + 8 + 1 + 6 = 48 bytes
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Counter {
    /// Account type discriminator
    pub discriminator: u8,
    /// Owner of this counter
    pub authority: [u8; 32],
    /// Current count value
    pub count: u64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 6],
}

impl Counter {
    pub const LEN: usize = core::mem::size_of::<Self>();

    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"counter";

    /// Derive the counter PDA for a given authority
    pub fn derive_pda(authority: &[u8; 32], program_id: &pinocchio::pubkey::Pubkey) -> (pinocchio::pubkey::Pubkey, u8) {
        pinocchio::pubkey::Pubkey::find_program_address(
            &[Self::SEED_PREFIX, authority],
            program_id,
        )
    }

    /// Zero-copy read from account
    pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;

        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        if data[0] != COUNTER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    /// Zero-copy mutable access
    pub fn from_account_mut(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;

        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        // Allow uninitialized (discriminator = 0) for first write
        if data[0] != COUNTER_DISCRIMINATOR && data[0] != 0 {
            return Err(ProgramError::InvalidAccountData);
        }

        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }
}
```

## src/error.rs

```rust
use pinocchio::program_error::ProgramError;

/// Custom program errors
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum CounterError {
    /// Counter already initialized
    AlreadyInitialized = 0,
    /// Counter underflow (would go negative)
    Underflow = 1,
    /// Invalid authority
    InvalidAuthority = 2,
}

impl From<CounterError> for ProgramError {
    fn from(e: CounterError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
```

## src/instructions/mod.rs

```rust
pub mod decrement;
pub mod increment;
pub mod initialize;
pub mod reset;
```

## src/instructions/initialize.rs

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvar::rent::Rent,
};
use pinocchio_system::instructions::CreateAccount;

use crate::state::{Counter, COUNTER_DISCRIMINATOR};

/// Initialize a new counter for a user
///
/// Accounts:
/// 0. `[writable]` Counter PDA (to be created)
/// 1. `[signer]` Authority (owner of the counter)
/// 2. `[]` System Program
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    // Parse accounts
    let [counter, authority, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate system program
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Derive and validate PDA
    let authority_bytes = authority.key().to_bytes();
    let (expected_pda, bump) = Counter::derive_pda(&authority_bytes, program_id);

    if counter.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create counter account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(Counter::LEN);

    CreateAccount {
        from: authority,
        to: counter,
        lamports,
        space: Counter::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[&[Counter::SEED_PREFIX, &authority_bytes, &[bump]]])?;

    // Initialize counter data
    let counter_data = Counter::from_account_mut(counter)?;
    counter_data.discriminator = COUNTER_DISCRIMINATOR;
    counter_data.authority = authority_bytes;
    counter_data.count = 0;
    counter_data.bump = bump;

    pinocchio::msg!("Counter initialized for {:?}", authority.key());

    Ok(())
}
```

## src/instructions/increment.rs

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::state::Counter;

/// Increment the counter by 1
///
/// Accounts:
/// 0. `[writable]` Counter PDA
/// 1. `[signer]` Authority
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [counter, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate counter ownership
    if counter.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Load and validate counter
    let counter_data = Counter::from_account_mut(counter)?;

    // Verify authority
    if counter_data.authority != authority.key().to_bytes() {
        return Err(crate::error::CounterError::InvalidAuthority.into());
    }

    // Increment with overflow check
    counter_data.count = counter_data
        .count
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    pinocchio::msg!("Counter incremented to {}", counter_data.count);

    Ok(())
}
```

## src/instructions/decrement.rs

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::{error::CounterError, state::Counter};

/// Decrement the counter by 1
///
/// Accounts:
/// 0. `[writable]` Counter PDA
/// 1. `[signer]` Authority
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [counter, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if counter.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let counter_data = Counter::from_account_mut(counter)?;

    if counter_data.authority != authority.key().to_bytes() {
        return Err(CounterError::InvalidAuthority.into());
    }

    // Decrement with underflow check
    counter_data.count = counter_data
        .count
        .checked_sub(1)
        .ok_or(CounterError::Underflow)?;

    pinocchio::msg!("Counter decremented to {}", counter_data.count);

    Ok(())
}
```

## src/instructions/reset.rs

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::{error::CounterError, state::Counter};

/// Reset the counter to 0
///
/// Accounts:
/// 0. `[writable]` Counter PDA
/// 1. `[signer]` Authority
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [counter, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if counter.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let counter_data = Counter::from_account_mut(counter)?;

    if counter_data.authority != authority.key().to_bytes() {
        return Err(CounterError::InvalidAuthority.into());
    }

    counter_data.count = 0;

    pinocchio::msg!("Counter reset to 0");

    Ok(())
}
```

## Key Patterns Demonstrated

1. **Single-byte discriminator routing** in `lib.rs`
2. **Bytemuck zero-copy** for account data
3. **PDA derivation and validation**
4. **Account ownership checks**
5. **Custom error types**
6. **Modular instruction organization**
7. **Arithmetic overflow/underflow protection**

## Build & Deploy

```bash
# Build
cargo build-sbf

# Deploy (devnet)
solana program deploy target/deploy/counter.so --url devnet

# Get program ID
solana address -k target/deploy/counter-keypair.json
```

## Compute Unit Usage

| Instruction | Approximate CU |
|-------------|----------------|
| Initialize | ~5,000 (includes account creation) |
| Increment | ~800 |
| Decrement | ~800 |
| Reset | ~750 |

Compare to Anchor: Initialize ~25,000 CU, Increment ~3,500 CU
