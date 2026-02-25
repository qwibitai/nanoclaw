# CPI Reference for Pinocchio

Cross-Program Invocation (CPI) patterns using Pinocchio's helper crates and manual approaches.

## Quick Reference

| Operation | Crate | Struct |
|-----------|-------|--------|
| Create Account | `pinocchio-system` | `CreateAccount` |
| Transfer SOL | `pinocchio-system` | `Transfer` |
| Allocate Space | `pinocchio-system` | `Allocate` |
| Assign Owner | `pinocchio-system` | `Assign` |
| Transfer Tokens | `pinocchio-token` | `Transfer` |
| Mint Tokens | `pinocchio-token` | `MintTo` |
| Burn Tokens | `pinocchio-token` | `Burn` |
| Approve Delegate | `pinocchio-token` | `Approve` |

---

## Setup

```toml
[dependencies]
pinocchio = { version = "0.10", features = ["cpi"] }
pinocchio-system = "0.4"
pinocchio-token = "0.4"
```

---

## System Program CPIs

### Create Account

```rust
use pinocchio_system::instructions::CreateAccount;

// Basic account creation
CreateAccount {
    from: payer,          // AccountInfo - pays for rent
    to: new_account,      // AccountInfo - account to create
    lamports: rent_amount,
    space: account_size,
    owner: &program_id,   // Owner program of new account
}.invoke()?;

// Create PDA (requires signed seeds)
CreateAccount {
    from: payer,
    to: pda_account,
    lamports: rent_lamports,
    space: data_size,
    owner: &crate::ID,
}.invoke_signed(&[&[
    b"seed",
    user.key().as_ref(),
    &[bump],
]])?;
```

### Transfer SOL

```rust
use pinocchio_system::instructions::Transfer;

// Basic transfer (from signer)
Transfer {
    from: sender,         // Must be signer
    to: recipient,
    lamports: amount,
}.invoke()?;

// Transfer from PDA
Transfer {
    from: vault_pda,
    to: recipient,
    lamports: withdraw_amount,
}.invoke_signed(&[&[
    b"vault",
    owner.key().as_ref(),
    &[bump],
]])?;
```

### Allocate Space

```rust
use pinocchio_system::instructions::Allocate;

// Allocate space to an account
Allocate {
    account: target_account,  // Must be signer or PDA
    space: new_size,
}.invoke()?;
```

### Assign Owner

```rust
use pinocchio_system::instructions::Assign;

// Change account owner
Assign {
    account: target_account,
    owner: &new_owner_program,
}.invoke()?;
```

### Create Account with Seed

```rust
use pinocchio_system::instructions::CreateAccountWithSeed;

CreateAccountWithSeed {
    from: payer,
    to: new_account,
    base: base_account,
    seed: "my_seed",
    lamports: rent_amount,
    space: account_size,
    owner: &program_id,
}.invoke()?;
```

---

## Token Program CPIs

### Initialize Mint

```rust
use pinocchio_token::instructions::InitializeMint2;

InitializeMint2 {
    mint: mint_account,
    decimals: 9,
    mint_authority: authority.key(),
    freeze_authority: None,  // Option<&Pubkey>
}.invoke()?;
```

### Initialize Token Account

```rust
use pinocchio_token::instructions::InitializeAccount3;

InitializeAccount3 {
    account: token_account,
    mint: mint_account,
    owner: owner.key(),
}.invoke()?;
```

### Transfer Tokens

```rust
use pinocchio_token::instructions::Transfer;

// Basic transfer
Transfer {
    source: from_token_account,
    destination: to_token_account,
    authority: owner,
    amount: token_amount,
}.invoke()?;

// Transfer with PDA authority
Transfer {
    source: vault_token_account,
    destination: user_token_account,
    authority: vault_pda,
    amount: withdraw_amount,
}.invoke_signed(&[&[
    b"vault",
    mint.key().as_ref(),
    &[bump],
]])?;
```

### Mint Tokens

```rust
use pinocchio_token::instructions::MintTo;

// Mint to token account
MintTo {
    mint: mint_account,
    token_account: destination,
    authority: mint_authority,
    amount: mint_amount,
}.invoke()?;

// Mint with PDA authority
MintTo {
    mint: mint_account,
    token_account: destination,
    authority: mint_authority_pda,
    amount: reward_amount,
}.invoke_signed(&[&[
    b"mint_authority",
    &[authority_bump],
]])?;
```

### Burn Tokens

```rust
use pinocchio_token::instructions::Burn;

Burn {
    mint: mint_account,
    token_account: source,
    authority: owner,
    amount: burn_amount,
}.invoke()?;
```

### Approve Delegate

```rust
use pinocchio_token::instructions::Approve;

Approve {
    source: token_account,
    delegate: delegate.key(),
    owner: owner,
    amount: approved_amount,
}.invoke()?;
```

### Revoke Delegate

```rust
use pinocchio_token::instructions::Revoke;

Revoke {
    source: token_account,
    owner: owner,
}.invoke()?;
```

### Close Account

```rust
use pinocchio_token::instructions::CloseAccount;

CloseAccount {
    account: token_account,
    destination: sol_destination,  // Receives remaining lamports
    authority: owner,
}.invoke()?;
```

### Set Authority

```rust
use pinocchio_token::instructions::SetAuthority;
use pinocchio_token::state::AuthorityType;

SetAuthority {
    account: mint_or_token_account,
    authority: current_authority,
    authority_type: AuthorityType::MintTokens,
    new_authority: Some(new_authority.key()),
}.invoke()?;
```

---

## Token-2022 CPIs

```rust
use pinocchio_token::instructions::{
    InitializeMetadataPointer,
    InitializeTokenMetadata,
};
use pinocchio_token::TokenProgramVariant;

// Initialize mint with Token-2022
InitializeMint2 {
    mint: mint_account,
    decimals: 9,
    mint_authority: authority.key(),
    freeze_authority: None,
}.invoke(TokenProgramVariant::Token2022)?;

// Add metadata pointer extension
InitializeMetadataPointer {
    mint: mint_account,
    authority: Some(*authority.key()),
    metadata_address: Some(*mint_account.key()),
}.invoke()?;

// Initialize token metadata
InitializeTokenMetadata {
    metadata: mint_account,
    update_authority: authority,
    mint: mint_account,
    mint_authority: authority,
    name: "My Token",
    symbol: "MTK",
    uri: "https://example.com/metadata.json",
}.invoke()?;
```

---

## Manual CPI (Third-Party Programs)

For programs without helper crates:

```rust
use pinocchio::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program::invoke_signed,
};

// Build instruction manually
fn custom_cpi(
    program_id: &Pubkey,
    account1: &AccountInfo,
    account2: &AccountInfo,
    data: &[u8],
) -> ProgramResult {
    let accounts = [
        AccountMeta::new(*account1.key(), false),      // Writable, not signer
        AccountMeta::new_readonly(*account2.key(), true), // Readonly, signer
    ];

    let instruction = Instruction {
        program_id,
        accounts: &accounts,
        data,
    };

    invoke(&instruction, &[account1, account2])
}

// With PDA signing
fn custom_cpi_signed(
    program_id: &Pubkey,
    pda_account: &AccountInfo,
    other_account: &AccountInfo,
    data: &[u8],
    seeds: &[&[u8]],
) -> ProgramResult {
    let accounts = [
        AccountMeta::new(*pda_account.key(), true),  // PDA signs
        AccountMeta::new(*other_account.key(), false),
    ];

    let instruction = Instruction {
        program_id,
        accounts: &accounts,
        data,
    };

    invoke_signed(&instruction, &[pda_account, other_account], &[seeds])
}
```

### Example: Jupiter Swap CPI

```rust
// Jupiter swap instruction data format (simplified)
#[repr(C, packed)]
struct SwapData {
    discriminator: u64,
    amount_in: u64,
    minimum_amount_out: u64,
}

fn jupiter_swap(
    jupiter_program: &Pubkey,
    accounts: &[AccountInfo],
    amount_in: u64,
    min_out: u64,
) -> ProgramResult {
    let data = SwapData {
        discriminator: 0x1234567890abcdef, // Jupiter's discriminator
        amount_in,
        minimum_amount_out: min_out,
    };

    let data_bytes = unsafe {
        std::slice::from_raw_parts(
            &data as *const _ as *const u8,
            std::mem::size_of::<SwapData>(),
        )
    };

    // Build account metas based on Jupiter's requirements
    let account_metas: Vec<AccountMeta> = accounts
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            // Determine writable/signer based on position
            match i {
                0 => AccountMeta::new(*acc.key(), true),  // User (signer)
                1..=3 => AccountMeta::new(*acc.key(), false), // Token accounts
                _ => AccountMeta::new_readonly(*acc.key(), false),
            }
        })
        .collect();

    let instruction = Instruction {
        program_id: jupiter_program,
        accounts: &account_metas,
        data: data_bytes,
    };

    invoke(&instruction, accounts)
}
```

---

## CPI with Multiple Signers

```rust
// Two PDAs signing the same CPI
fn multi_signer_cpi(
    accounts: &[AccountInfo],
    pda1_seeds: &[&[u8]],
    pda2_seeds: &[&[u8]],
) -> ProgramResult {
    let instruction = /* ... */;

    invoke_signed(
        &instruction,
        accounts,
        &[pda1_seeds, pda2_seeds],  // Multiple signer seed sets
    )
}
```

---

## CPI Error Handling

```rust
use pinocchio::program_error::ProgramError;

fn safe_cpi(/* ... */) -> ProgramResult {
    let result = Transfer {
        from: source,
        to: destination,
        lamports: amount,
    }.invoke();

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // Log error for debugging
            pinocchio::msg!("CPI failed: {:?}", e);

            // Optionally convert to custom error
            Err(ProgramError::Custom(1001))
        }
    }
}
```

---

## CPI Compute Costs

| Operation | Approximate CU |
|-----------|----------------|
| System Transfer | ~150 |
| Create Account | ~5,000 |
| Token Transfer | ~4,000 |
| Token Mint | ~4,500 |
| Token Burn | ~4,000 |
| Initialize Mint | ~2,500 |

*Note: These are Pinocchio-optimized costs. Traditional approaches use 2-5x more.*

---

## Best Practices

1. **Validate before CPI** - Check all accounts before invoking external programs
2. **Check return values** - Always handle CPI errors
3. **Minimize CPI depth** - Each level adds overhead
4. **Use helper crates** - `pinocchio-system` and `pinocchio-token` are optimized
5. **Pre-compute PDAs** - Don't derive in hot paths if bump is known
6. **Batch operations** - Multiple transfers in one instruction when possible

---

## Common CPI Patterns

### Create + Initialize Pattern

```rust
// Create account then initialize in same instruction
fn create_and_init_vault(
    payer: &AccountInfo,
    vault: &AccountInfo,
    owner: &AccountInfo,
    program_id: &Pubkey,
    bump: u8,
) -> ProgramResult {
    let seeds = &[b"vault", owner.key().as_ref(), &[bump]];

    // Step 1: Create account
    CreateAccount {
        from: payer,
        to: vault,
        lamports: Rent::get()?.minimum_balance(Vault::LEN),
        space: Vault::LEN as u64,
        owner: program_id,
    }.invoke_signed(&[seeds])?;

    // Step 2: Initialize data
    let vault_data = Vault::from_account_mut(vault)?;
    vault_data.discriminator = VAULT_DISCRIMINATOR;
    vault_data.owner = owner.key().to_bytes();
    vault_data.balance = 0;
    vault_data.bump = bump;

    Ok(())
}
```

### Transfer + Close Pattern

```rust
// Transfer tokens then close empty account
fn withdraw_and_close(
    token_account: &AccountInfo,
    destination: &AccountInfo,
    sol_destination: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    // Get current balance
    let account_data = token_account.try_borrow_data()?;
    let amount = u64::from_le_bytes(
        account_data[64..72].try_into().unwrap()
    );
    drop(account_data);

    // Transfer all tokens
    if amount > 0 {
        Transfer {
            source: token_account,
            destination,
            authority,
            amount,
        }.invoke()?;
    }

    // Close account
    CloseAccount {
        account: token_account,
        destination: sol_destination,
        authority,
    }.invoke()?;

    Ok(())
}
```
