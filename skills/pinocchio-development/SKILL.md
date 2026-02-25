---
name: pinocchio-development
description: Comprehensive guide for building high-performance Solana programs using Pinocchio - the zero-dependency, zero-copy framework. Covers account validation, CPI patterns, optimization techniques, and migration from Anchor.
---

# Pinocchio Development Guide

Build blazing-fast Solana programs with Pinocchio - a zero-dependency, zero-copy framework that delivers **88-95% compute unit reduction** and **40% smaller binaries** compared to traditional approaches.

## Overview

Pinocchio is Anza's minimalist Rust library for writing Solana programs without the heavyweight `solana-program` crate. It treats incoming transaction data as a single byte slice, reading it in-place via zero-copy techniques.

### Performance Comparison

| Metric | Anchor | Native (solana-program) | Pinocchio |
|--------|--------|------------------------|-----------|
| Token Transfer CU | ~6,000 | ~4,500 | ~600-800 |
| Binary Size | Large | Medium | Small (-40%) |
| Heap Allocation | Required | Required | Optional |
| Dependencies | Many | Several | Zero* |

*Only Solana SDK types for on-chain execution

### When to Use Pinocchio

**Use Pinocchio When:**
- Building high-throughput programs (DEXs, orderbooks, games)
- Compute units are a bottleneck
- Binary size matters (program deployment costs)
- You need maximum control over memory
- Building infrastructure (tokens, vaults, escrows)

**Consider Anchor Instead When:**
- Rapid prototyping / MVPs
- Team unfamiliar with low-level Rust
- Complex account relationships
- Need extensive ecosystem tooling
- Audit timeline is tight (more auditors know Anchor)

## Quick Start

### 1. Project Setup

```toml
# Cargo.toml
[package]
name = "my-program"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[features]
default = []
bpf-entrypoint = []

[dependencies]
pinocchio = "0.10"
pinocchio-system = "0.4"      # System Program CPI helpers
pinocchio-token = "0.4"       # Token Program CPI helpers
bytemuck = { version = "1.14", features = ["derive"] }

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
opt-level = 3
```

### 2. Basic Program Structure

```rust
use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

// Declare entrypoint
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Route instructions by discriminator (first byte)
    match instruction_data.first() {
        Some(0) => initialize(accounts, &instruction_data[1..]),
        Some(1) => execute(accounts, &instruction_data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

### 3. Account Definition with Bytemuck

```rust
use bytemuck::{Pod, Zeroable};

// Single-byte discriminator for account type
pub const VAULT_DISCRIMINATOR: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Vault {
    pub discriminator: u8,
    pub owner: [u8; 32],      // Pubkey as bytes
    pub balance: u64,
    pub bump: u8,
    pub _padding: [u8; 6],    // Align to 8 bytes
}

impl Vault {
    pub const LEN: usize = std::mem::size_of::<Self>();

    pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != VAULT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    pub fn from_account_mut(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }
}
```

## Instructions

### Step 1: Define Account Validation

Create a struct to hold validated accounts:

```rust
pub struct InitializeAccounts<'a> {
    pub vault: &'a AccountInfo,
    pub owner: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> InitializeAccounts<'a> {
    pub fn parse(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        let [vault, owner, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Validate owner is signer
        if !owner.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Validate system program
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self {
            vault,
            owner,
            system_program,
        })
    }
}
```

### Step 2: Implement Instruction Handler

```rust
use pinocchio_system::instructions::CreateAccount;

pub fn initialize(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ctx = InitializeAccounts::parse(accounts)?;

    // Derive PDA
    let (pda, bump) = Pubkey::find_program_address(
        &[b"vault", ctx.owner.key().as_ref()],
        &crate::ID,
    );

    // Verify PDA matches
    if ctx.vault.key() != &pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create account via CPI
    let space = Vault::LEN as u64;
    let rent = pinocchio::sysvar::rent::Rent::get()?;
    let lamports = rent.minimum_balance(space as usize);

    CreateAccount {
        from: ctx.owner,
        to: ctx.vault,
        lamports,
        space,
        owner: &crate::ID,
    }
    .invoke_signed(&[&[b"vault", ctx.owner.key().as_ref(), &[bump]]])?;

    // Initialize account data
    let vault = Vault::from_account_mut(ctx.vault)?;
    vault.discriminator = VAULT_DISCRIMINATOR;
    vault.owner = ctx.owner.key().to_bytes();
    vault.balance = 0;
    vault.bump = bump;

    Ok(())
}
```

## Entrypoint Options

Pinocchio provides three entrypoint macros with different trade-offs:

### 1. Standard Entrypoint (Recommended for most cases)

```rust
use pinocchio::entrypoint;

entrypoint!(process_instruction);
```

- Sets up heap allocator
- Configures panic handler
- Deserializes accounts automatically

### 2. Lazy Entrypoint (Best for single-instruction programs)

```rust
use pinocchio::lazy_entrypoint;

lazy_entrypoint!(process_instruction);

pub fn process_instruction(mut context: InstructionContext) -> ProgramResult {
    // Accounts parsed on-demand
    let account = context.next_account()?;
    let data = context.instruction_data();
    Ok(())
}
```

- Defers parsing until needed
- Best CU savings for simple programs
- **80-87% CU reduction** in memo program benchmarks

### 3. No Allocator (Maximum optimization)

```rust
use pinocchio::{entrypoint, no_allocator};

no_allocator!();
entrypoint!(process_instruction);
```

- Disables heap entirely
- Cannot use `String`, `Vec`, `Box`
- Best for statically-sized operations

## CPI Patterns

### System Program CPI

```rust
use pinocchio_system::instructions::{CreateAccount, Transfer};

// Create account
CreateAccount {
    from: payer,
    to: new_account,
    lamports: rent_lamports,
    space: account_size,
    owner: &program_id,
}.invoke()?;

// Transfer SOL
Transfer {
    from: source,
    to: destination,
    lamports: amount,
}.invoke()?;

// Transfer with PDA signer
Transfer {
    from: pda_account,
    to: destination,
    lamports: amount,
}.invoke_signed(&[&[b"vault", owner.as_ref(), &[bump]]])?;
```

### Token Program CPI

```rust
use pinocchio_token::instructions::{Transfer, MintTo, Burn};

// Transfer tokens
Transfer {
    source: from_token_account,
    destination: to_token_account,
    authority: owner,
    amount: token_amount,
}.invoke()?;

// Mint tokens (with PDA authority)
MintTo {
    mint: mint_account,
    token_account: destination,
    authority: mint_authority_pda,
    amount: mint_amount,
}.invoke_signed(&[&[b"mint_auth", &[bump]]])?;
```

### Custom CPI (Third-party programs)

```rust
use pinocchio::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

// Build instruction manually
let accounts = vec![
    AccountMeta::new(*account1.key(), false),
    AccountMeta::new_readonly(*account2.key(), true),
];

let ix = Instruction {
    program_id: &external_program_id,
    accounts: &accounts,
    data: &instruction_data,
};

invoke(&ix, &[account1, account2])?;
```

## Account Validation Patterns

### Pattern 1: TryFrom Trait

```rust
pub struct DepositAccounts<'a> {
    pub vault: &'a AccountInfo,
    pub owner: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for DepositAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [vault, owner, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Validations
        require!(owner.is_signer(), ProgramError::MissingRequiredSignature);
        require!(vault.is_writable(), ProgramError::InvalidAccountData);

        Ok(Self { vault, owner, system_program })
    }
}

// Usage
let ctx = DepositAccounts::try_from(accounts)?;
```

### Pattern 2: Builder Pattern

```rust
pub struct AccountValidator<'a> {
    account: &'a AccountInfo,
}

impl<'a> AccountValidator<'a> {
    pub fn new(account: &'a AccountInfo) -> Self {
        Self { account }
    }

    pub fn is_signer(self) -> Result<Self, ProgramError> {
        if !self.account.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        Ok(self)
    }

    pub fn is_writable(self) -> Result<Self, ProgramError> {
        if !self.account.is_writable() {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(self)
    }

    pub fn has_owner(self, owner: &Pubkey) -> Result<Self, ProgramError> {
        if self.account.owner() != owner {
            return Err(ProgramError::IllegalOwner);
        }
        Ok(self)
    }

    pub fn build(self) -> &'a AccountInfo {
        self.account
    }
}

// Usage
let owner = AccountValidator::new(&accounts[0])
    .is_signer()?
    .is_writable()?
    .build();
```

### Pattern 3: Macro-based Validation

```rust
macro_rules! require {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($err);
        }
    };
}

macro_rules! require_signer {
    ($account:expr) => {
        require!($account.is_signer(), ProgramError::MissingRequiredSignature)
    };
}

macro_rules! require_writable {
    ($account:expr) => {
        require!($account.is_writable(), ProgramError::InvalidAccountData)
    };
}
```

## PDA Operations

### Deriving PDAs

```rust
use pinocchio::pubkey::Pubkey;

// Find PDA with bump
let (pda, bump) = Pubkey::find_program_address(
    &[b"vault", user.key().as_ref()],
    program_id,
);

// Create PDA with known bump (cheaper)
let pda = Pubkey::create_program_address(
    &[b"vault", user.key().as_ref(), &[bump]],
    program_id,
)?;
```

### PDA Signing for CPI

```rust
// Single seed set
let signer_seeds = &[b"vault", owner.as_ref(), &[bump]];

Transfer {
    from: vault_pda,
    to: destination,
    lamports: amount,
}.invoke_signed(&[signer_seeds])?;

// Multiple PDA signers
let signer1 = &[b"vault", owner.as_ref(), &[bump1]];
let signer2 = &[b"authority", &[bump2]];

invoke_signed(&ix, &accounts, &[signer1, signer2])?;
```

## Data Serialization

### Fixed-Size with Bytemuck (Recommended)

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GameState {
    pub discriminator: u8,
    pub player: [u8; 32],
    pub score: u64,
    pub level: u8,
    pub _padding: [u8; 6],
}

// Zero-copy read
let state: &GameState = bytemuck::from_bytes(&data);

// Zero-copy write
let state: &mut GameState = bytemuck::from_bytes_mut(&mut data);
```

### Variable-Size with Borsh

```rust
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize)]
pub struct Metadata {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

// Deserialize (allocates)
let metadata = Metadata::try_from_slice(data)?;

// Serialize
let mut buffer = Vec::new();
metadata.serialize(&mut buffer)?;
```

### Manual Parsing (Maximum control)

```rust
pub fn parse_u64(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(u64::from_le_bytes(data[..8].try_into().unwrap()))
}

pub fn parse_pubkey(data: &[u8]) -> Result<Pubkey, ProgramError> {
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(Pubkey::new_from_array(data[..32].try_into().unwrap()))
}
```

## IDL Generation with Shank

Since Pinocchio doesn't auto-generate IDLs, use Shank:

```rust
use shank::{ShankAccount, ShankInstruction};

#[derive(ShankAccount)]
pub struct Vault {
    pub owner: Pubkey,
    pub balance: u64,
}

#[derive(ShankInstruction)]
pub enum ProgramInstruction {
    #[account(0, writable, signer, name = "vault")]
    #[account(1, signer, name = "owner")]
    #[account(2, name = "system_program")]
    Initialize,

    #[account(0, writable, name = "vault")]
    #[account(1, signer, name = "owner")]
    Deposit { amount: u64 },
}
```

Generate IDL:
```bash
shank idl -o idl.json -p src/lib.rs
```

## Guidelines

1. **Always use single-byte discriminators** for instructions and accounts
2. **Prefer bytemuck over Borsh** for fixed-size data
3. **Use `lazy_entrypoint!`** for single-instruction programs
4. **Validate all accounts** before processing
5. **Use `invoke_signed`** for PDA-owned account operations
6. **Add padding** to align structs to 8 bytes
7. **Test with `solana-program-test`** or Bankrun

## Files in This Skill

```
pinocchio-development/
├── SKILL.md                           # This file
├── scripts/
│   ├── scaffold-program.sh            # Project generator
│   └── benchmark-cu.sh                # CU benchmarking
├── resources/
│   ├── account-patterns.md            # Validation patterns
│   ├── cpi-reference.md               # CPI quick reference
│   ├── optimization-checklist.md      # Performance tips
│   └── anchor-comparison.md           # Side-by-side comparison
├── examples/
│   ├── counter/                       # Basic counter program
│   ├── vault/                         # PDA vault with deposits
│   ├── token-operations/              # Token minting/transfers
│   └── transfer-hook/                 # Token-2022 hook
├── templates/
│   └── program-template.rs            # Starter template
└── docs/
    ├── migration-from-anchor.md       # Anchor migration guide
    └── edge-cases.md                  # Gotchas and solutions
```

## Performance Benchmarks (2025)

Latest benchmarks demonstrate Pinocchio's efficiency:

| Program | Anchor CU | Pinocchio CU | Reduction |
|---------|-----------|--------------|-----------|
| Token Transfer | ~6,000 | ~600-800 | **88-95%** |
| Memo Program | ~650 | ~108 | **83%** |
| Counter | ~800 | ~104 | **87%** |

*Assembly implementation: 104 CU, Pinocchio: 108 CU, Basic Anchor: 649 CU*

## SDK Roadmap (Anza Plans)

The Anza team has announced plans for SDK v3:

### Coming Improvements
- **Unified Base Types**: Reusable types across Anchor and Pinocchio
- **New Serialization Library**: Zero-copy, simpler enums, variable-length types
- **ATA Program Optimization**: Pinocchio-optimized Associated Token Account
- **Token22 Optimization**: Full Token Extensions support with minimal CU usage

### Integration Progress
- Pinocchio types are being integrated into the core Solana SDK
- Improved interoperability between Anchor and Pinocchio programs

## Notes

- Pinocchio is **unaudited** - use with caution in production
- Version 0.10.x is current (latest: `pinocchio = "0.10"`)
- `pinocchio-system = "0.4"` and `pinocchio-token = "0.4"` for CPI helpers
- Token-2022 support via `pinocchio-token` is under active development
- For client generation, use **Codama** with your Shank-generated IDL
- Maintained by Anza (Solana Agave client developers)
