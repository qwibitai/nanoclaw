//! Pinocchio Program Template
//!
//! A minimal starting point for Pinocchio programs.
//! Replace placeholders with your program logic.

#![cfg_attr(not(test), no_std)]

use bytemuck::{Pod, Zeroable};
use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

// ============================================================================
// PROGRAM ID
// ============================================================================

pinocchio::declare_id!("11111111111111111111111111111111"); // Replace with your program ID

// ============================================================================
// INSTRUCTION DISCRIMINATORS
// ============================================================================

pub const INITIALIZE: u8 = 0;
pub const UPDATE: u8 = 1;
pub const CLOSE: u8 = 2;

// ============================================================================
// ACCOUNT DISCRIMINATORS
// ============================================================================

pub const ACCOUNT_DISCRIMINATOR: u8 = 1;

// ============================================================================
// ACCOUNT STRUCTURES
// ============================================================================

/// Main program account
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MyAccount {
    /// Account type discriminator
    pub discriminator: u8,
    /// Account owner
    pub authority: [u8; 32],
    /// Example data field
    pub data: u64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 6],
}

impl MyAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED_PREFIX: &'static [u8] = b"my_account";

    pub fn derive_pda(authority: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, authority.as_ref()],
            program_id,
        )
    }

    pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != ACCOUNT_DISCRIMINATOR {
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

// ============================================================================
// ERRORS
// ============================================================================

#[derive(Debug, Clone, Copy)]
#[repr(u32)]
pub enum MyError {
    InvalidAuthority = 0,
    AlreadyInitialized = 1,
    NotInitialized = 2,
}

impl From<MyError> for ProgramError {
    fn from(e: MyError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// ============================================================================
// ENTRYPOINT
// ============================================================================

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

    // Route by discriminator
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        &INITIALIZE => process_initialize(program_id, accounts, data),
        &UPDATE => process_update(program_id, accounts, data),
        &CLOSE => process_close(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ============================================================================
// INSTRUCTION HANDLERS
// ============================================================================

/// Initialize a new account
fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [account, authority, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate system program
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Derive and validate PDA
    let (expected_pda, bump) = MyAccount::derive_pda(authority.key(), program_id);
    if account.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check not already initialized
    if !account.data_is_empty() {
        return Err(MyError::AlreadyInitialized.into());
    }

    // Create account
    let rent = pinocchio::sysvar::rent::Rent::get()?;
    let lamports = rent.minimum_balance(MyAccount::LEN);

    pinocchio_system::instructions::CreateAccount {
        from: authority,
        to: account,
        lamports,
        space: MyAccount::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[&[
        MyAccount::SEED_PREFIX,
        authority.key().as_ref(),
        &[bump],
    ]])?;

    // Initialize data
    let account_data = MyAccount::from_account_mut(account)?;
    account_data.discriminator = ACCOUNT_DISCRIMINATOR;
    account_data.authority = authority.key().to_bytes();
    account_data.data = 0;
    account_data.bump = bump;

    pinocchio::msg!("Account initialized");

    Ok(())
}

/// Update account data
fn process_update(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse instruction data
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let new_value = u64::from_le_bytes(data[..8].try_into().unwrap());

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owner
    if account.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Load and validate account
    let account_data = MyAccount::from_account_mut(account)?;

    if account_data.authority != authority.key().to_bytes() {
        return Err(MyError::InvalidAuthority.into());
    }

    // Update data
    account_data.data = new_value;

    pinocchio::msg!("Account updated: data = {}", new_value);

    Ok(())
}

/// Close account and return lamports
fn process_close(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owner
    if account.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Load and validate account
    let account_data = MyAccount::from_account(account)?;

    if account_data.authority != authority.key().to_bytes() {
        return Err(MyError::InvalidAuthority.into());
    }

    // Transfer lamports to authority
    let lamports = account.lamports();
    **account.try_borrow_mut_lamports()? = 0;
    **authority.try_borrow_mut_lamports()? += lamports;

    // Zero account data
    account.try_borrow_mut_data()?.fill(0);

    // Assign to system program
    account.assign(&pinocchio_system::ID);

    pinocchio::msg!("Account closed");

    Ok(())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_account_size() {
        assert_eq!(MyAccount::LEN, 48);
    }
}
