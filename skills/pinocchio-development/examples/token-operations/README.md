# Pinocchio Token Operations Example

Comprehensive examples for SPL Token and Token-2022 operations using Pinocchio's helper crates.

## Overview

This example demonstrates:
- Creating mints (SPL Token & Token-2022)
- Creating token accounts
- Minting tokens
- Transferring tokens
- Token-2022 with metadata extension

## Dependencies

```toml
[dependencies]
pinocchio = { version = "0.10", features = ["cpi"] }
pinocchio-system = "0.4"
pinocchio-token = "0.4"
bytemuck = { version = "1.14", features = ["derive"] }
borsh = "1.5"  # For variable-length metadata
```

---

## 1. Create SPL Token Mint

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::rent::Rent,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::{
    instructions::InitializeMint2,
    state::Mint,
    ID as TOKEN_PROGRAM_ID,
};

/// Create a new SPL Token mint
///
/// Accounts:
/// 0. `[writable, signer]` Mint account (new keypair)
/// 1. `[writable, signer]` Payer
/// 2. `[]` Mint authority
/// 3. `[]` Token Program
/// 4. `[]` System Program
pub fn create_mint(
    accounts: &[AccountInfo],
    decimals: u8,
) -> ProgramResult {
    let [mint, payer, mint_authority, token_program, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate programs
    if token_program.key() != &TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Calculate rent
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(Mint::LEN);

    // Create mint account
    CreateAccount {
        from: payer,
        to: mint,
        lamports,
        space: Mint::LEN as u64,
        owner: &TOKEN_PROGRAM_ID,
    }
    .invoke()?;

    // Initialize mint
    InitializeMint2 {
        mint,
        decimals,
        mint_authority: mint_authority.key(),
        freeze_authority: None,
    }
    .invoke()?;

    pinocchio::msg!("Mint created: {:?}", mint.key());

    Ok(())
}
```

---

## 2. Create Token Account

```rust
use pinocchio_token::{
    instructions::InitializeAccount3,
    state::TokenAccount,
    ID as TOKEN_PROGRAM_ID,
};

/// Create and initialize a token account
///
/// Accounts:
/// 0. `[writable, signer]` Token account (new keypair)
/// 1. `[]` Mint
/// 2. `[]` Owner
/// 3. `[writable, signer]` Payer
/// 4. `[]` Token Program
/// 5. `[]` System Program
pub fn create_token_account(accounts: &[AccountInfo]) -> ProgramResult {
    let [token_account, mint, owner, payer, token_program, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(TokenAccount::LEN);

    // Create account
    CreateAccount {
        from: payer,
        to: token_account,
        lamports,
        space: TokenAccount::LEN as u64,
        owner: &TOKEN_PROGRAM_ID,
    }
    .invoke()?;

    // Initialize
    InitializeAccount3 {
        account: token_account,
        mint,
        owner: owner.key(),
    }
    .invoke()?;

    Ok(())
}
```

---

## 3. Create Associated Token Account (ATA)

```rust
use pinocchio_token::instructions::CreateAssociatedTokenAccount;

/// Create ATA for a user
///
/// Accounts:
/// 0. `[writable]` ATA (derived)
/// 1. `[]` Mint
/// 2. `[]` Owner
/// 3. `[writable, signer]` Payer
/// 4. `[]` Token Program
/// 5. `[]` Associated Token Program
/// 6. `[]` System Program
pub fn create_ata(accounts: &[AccountInfo]) -> ProgramResult {
    let [ata, mint, owner, payer, token_program, ata_program, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    CreateAssociatedTokenAccount {
        payer,
        associated_token: ata,
        owner,
        mint,
        system_program,
        token_program,
    }
    .invoke()?;

    Ok(())
}
```

---

## 4. Mint Tokens

```rust
use pinocchio_token::instructions::MintTo;

/// Mint tokens to a token account
///
/// Accounts:
/// 0. `[writable]` Mint
/// 1. `[writable]` Destination token account
/// 2. `[signer]` Mint authority
pub fn mint_tokens(
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let [mint, destination, mint_authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !mint_authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    MintTo {
        mint,
        token_account: destination,
        authority: mint_authority,
        amount,
    }
    .invoke()?;

    pinocchio::msg!("Minted {} tokens", amount);

    Ok(())
}

/// Mint tokens with PDA authority
pub fn mint_tokens_pda(
    accounts: &[AccountInfo],
    amount: u64,
    authority_seeds: &[&[u8]],
) -> ProgramResult {
    let [mint, destination, mint_authority_pda, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    MintTo {
        mint,
        token_account: destination,
        authority: mint_authority_pda,
        amount,
    }
    .invoke_signed(&[authority_seeds])?;

    Ok(())
}
```

---

## 5. Transfer Tokens

```rust
use pinocchio_token::instructions::Transfer;

/// Transfer tokens between accounts
///
/// Accounts:
/// 0. `[writable]` Source token account
/// 1. `[writable]` Destination token account
/// 2. `[signer]` Owner/Authority
pub fn transfer_tokens(
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let [source, destination, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    Transfer {
        source,
        destination,
        authority,
        amount,
    }
    .invoke()?;

    pinocchio::msg!("Transferred {} tokens", amount);

    Ok(())
}

/// Transfer from PDA-owned token account
pub fn transfer_from_pda(
    accounts: &[AccountInfo],
    amount: u64,
    pda_seeds: &[&[u8]],
) -> ProgramResult {
    let [source, destination, pda_authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    Transfer {
        source,
        destination,
        authority: pda_authority,
        amount,
    }
    .invoke_signed(&[pda_seeds])?;

    Ok(())
}
```

---

## 6. Token-2022 Mint with Metadata

```rust
use borsh::BorshDeserialize;
use pinocchio_token::{
    instructions::{
        InitializeMetadataPointer,
        InitializeMint2,
        InitializeTokenMetadata,
    },
    state::Mint,
    TokenProgramVariant,
    TOKEN_2022_PROGRAM_ID,
};

#[derive(BorshDeserialize)]
pub struct CreateTokenArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
}

/// Create Token-2022 mint with embedded metadata
///
/// Accounts:
/// 0. `[writable, signer]` Mint account
/// 1. `[signer]` Mint authority
/// 2. `[writable, signer]` Payer
/// 3. `[]` Token-2022 Program
/// 4. `[]` System Program
pub fn create_token_2022_with_metadata(
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let [mint, mint_authority, payer, token_program, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse instruction data
    let args = CreateTokenArgs::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // Validate Token-2022 program
    if token_program.key() != &TOKEN_2022_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Calculate sizes for extensions
    const METADATA_POINTER_SIZE: usize = 4 + 32 + 32; // type + authority + metadata_address
    const METADATA_BASE_SIZE: usize = 4 + 32 + 32 + 4 + 4 + 4 + 4; // tlv header + update_auth + mint + lengths
    const EXTENSION_PADDING: usize = 84; // Account type + padding

    let metadata_size = METADATA_BASE_SIZE + args.name.len() + args.symbol.len() + args.uri.len();
    let total_size = Mint::LEN + EXTENSION_PADDING + METADATA_POINTER_SIZE + metadata_size;

    // Create account with space for extensions
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(total_size);

    CreateAccount {
        from: payer,
        to: mint,
        lamports,
        space: total_size as u64,
        owner: &TOKEN_2022_PROGRAM_ID,
    }
    .invoke()?;

    // Initialize metadata pointer (must be before mint init)
    InitializeMetadataPointer {
        mint,
        authority: Some(*payer.key()),
        metadata_address: Some(*mint.key()), // Self-referential
    }
    .invoke()?;

    // Initialize mint
    InitializeMint2 {
        mint,
        decimals: args.decimals,
        mint_authority: mint_authority.key(),
        freeze_authority: None,
    }
    .invoke(TokenProgramVariant::Token2022)?;

    // Initialize metadata
    InitializeTokenMetadata {
        metadata: mint,
        update_authority: payer,
        mint,
        mint_authority: payer,
        name: &args.name,
        symbol: &args.symbol,
        uri: &args.uri,
    }
    .invoke()?;

    pinocchio::msg!(
        "Token-2022 created: {} ({}) - {}",
        args.name,
        args.symbol,
        mint.key()
    );

    Ok(())
}
```

---

## 7. Burn Tokens

```rust
use pinocchio_token::instructions::Burn;

/// Burn tokens
pub fn burn_tokens(
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let [mint, source, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    Burn {
        mint,
        token_account: source,
        authority,
        amount,
    }
    .invoke()?;

    Ok(())
}
```

---

## 8. Close Token Account

```rust
use pinocchio_token::instructions::CloseAccount;

/// Close empty token account and reclaim SOL
pub fn close_token_account(accounts: &[AccountInfo]) -> ProgramResult {
    let [token_account, destination, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    CloseAccount {
        account: token_account,
        destination,
        authority,
    }
    .invoke()?;

    Ok(())
}
```

---

## Reading Token Account Data

```rust
/// Read token account balance (zero-copy)
pub fn get_token_balance(token_account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = token_account.try_borrow_data()?;

    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Balance is at offset 64-72 in TokenAccount layout
    let amount_bytes: [u8; 8] = data[64..72].try_into().unwrap();
    Ok(u64::from_le_bytes(amount_bytes))
}

/// Read token account owner
pub fn get_token_owner(token_account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let data = token_account.try_borrow_data()?;

    if data.len() < 64 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Owner is at offset 32-64 in TokenAccount layout
    let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
    Ok(Pubkey::new_from_array(owner_bytes))
}

/// Verify token account belongs to expected mint
pub fn verify_token_mint(
    token_account: &AccountInfo,
    expected_mint: &Pubkey,
) -> Result<(), ProgramError> {
    let data = token_account.try_borrow_data()?;

    if data.len() < 32 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Mint is at offset 0-32 in TokenAccount layout
    let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
    let mint = Pubkey::new_from_array(mint_bytes);

    if &mint != expected_mint {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(())
}
```

---

## Compute Unit Comparison

| Operation | Pinocchio | Anchor/SPL |
|-----------|-----------|------------|
| Create Mint | ~4,500 CU | ~15,000 CU |
| Init Token Account | ~4,200 CU | ~12,000 CU |
| Transfer | ~4,000 CU | ~6,000 CU |
| Mint To | ~4,500 CU | ~7,500 CU |
| Burn | ~4,000 CU | ~6,500 CU |

---

## Common Patterns

### Batch Token Operations

```rust
/// Transfer tokens to multiple recipients
pub fn batch_transfer(
    source: &AccountInfo,
    destinations: &[&AccountInfo],
    authority: &AccountInfo,
    amounts: &[u64],
) -> ProgramResult {
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    for (dest, &amount) in destinations.iter().zip(amounts.iter()) {
        Transfer {
            source,
            destination: dest,
            authority,
            amount,
        }
        .invoke()?;
    }

    Ok(())
}
```

### Safe Transfer with Balance Check

```rust
pub fn safe_transfer(
    source: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    // Check source balance first
    let balance = get_token_balance(source)?;
    if balance < amount {
        return Err(ProgramError::InsufficientFunds);
    }

    Transfer {
        source,
        destination,
        authority,
        amount,
    }
    .invoke()?;

    Ok(())
}
```
