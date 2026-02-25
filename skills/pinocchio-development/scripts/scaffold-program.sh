#!/bin/bash

# Pinocchio Program Scaffolding Script
# Usage: ./scaffold-program.sh <program-name>

set -e

PROGRAM_NAME="${1:-my_program}"
PROGRAM_DIR="${PROGRAM_NAME//-/_}"

echo "Creating Pinocchio program: $PROGRAM_NAME"

# Create directory structure
mkdir -p "$PROGRAM_DIR/src/instructions"
mkdir -p "$PROGRAM_DIR/tests"

# Create Cargo.toml
cat > "$PROGRAM_DIR/Cargo.toml" << 'EOF'
[package]
name = "PROGRAM_NAME"
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
pinocchio-token = "0.4"
bytemuck = { version = "1.14", features = ["derive"] }
shank = "0.4"

[dev-dependencies]
solana-program-test = "2.0"
solana-sdk = "2.0"
tokio = { version = "1", features = ["full"] }

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
opt-level = 3
EOF

# Replace placeholder
sed -i '' "s/PROGRAM_NAME/$PROGRAM_NAME/g" "$PROGRAM_DIR/Cargo.toml" 2>/dev/null || \
sed -i "s/PROGRAM_NAME/$PROGRAM_NAME/g" "$PROGRAM_DIR/Cargo.toml"

# Create lib.rs
cat > "$PROGRAM_DIR/src/lib.rs" << 'EOF'
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

pinocchio::declare_id!("11111111111111111111111111111111");

pub const INITIALIZE: u8 = 0;

#[cfg(feature = "bpf-entrypoint")]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        &INITIALIZE => instructions::initialize::process(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
EOF

# Create state.rs
cat > "$PROGRAM_DIR/src/state.rs" << 'EOF'
use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

pub const ACCOUNT_DISCRIMINATOR: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MyAccount {
    pub discriminator: u8,
    pub owner: [u8; 32],
    pub data: u64,
    pub bump: u8,
    pub _padding: [u8; 6],
}

impl MyAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;
        if data.len() < Self::LEN || data[0] != ACCOUNT_DISCRIMINATOR {
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
EOF

# Create error.rs
cat > "$PROGRAM_DIR/src/error.rs" << 'EOF'
use pinocchio::program_error::ProgramError;

#[derive(Debug, Clone, Copy)]
#[repr(u32)]
pub enum MyError {
    InvalidAuthority = 0,
    AlreadyInitialized = 1,
}

impl From<MyError> for ProgramError {
    fn from(e: MyError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
EOF

# Create instructions mod
cat > "$PROGRAM_DIR/src/instructions/mod.rs" << 'EOF'
pub mod initialize;
EOF

# Create initialize instruction
cat > "$PROGRAM_DIR/src/instructions/initialize.rs" << 'EOF'
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [_account, authority, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // TODO: Implement initialization logic

    pinocchio::msg!("Initialize called");

    Ok(())
}
EOF

# Create .gitignore
cat > "$PROGRAM_DIR/.gitignore" << 'EOF'
target/
Cargo.lock
*.so
*.log
EOF

echo ""
echo "Created Pinocchio program in: $PROGRAM_DIR/"
echo ""
echo "Structure:"
echo "  $PROGRAM_DIR/"
echo "  ├── Cargo.toml"
echo "  ├── src/"
echo "  │   ├── lib.rs"
echo "  │   ├── state.rs"
echo "  │   ├── error.rs"
echo "  │   └── instructions/"
echo "  │       ├── mod.rs"
echo "  │       └── initialize.rs"
echo "  └── tests/"
echo ""
echo "Next steps:"
echo "  1. cd $PROGRAM_DIR"
echo "  2. Update program ID in src/lib.rs"
echo "  3. cargo build-sbf"
echo "  4. solana program deploy target/deploy/${PROGRAM_NAME}.so"
