# Edge Cases & Optimization Tips for Pinocchio

Common pitfalls, edge cases, and optimization techniques for Pinocchio development.

## Table of Contents

1. [Memory & Alignment Issues](#1-memory--alignment-issues)
2. [Account Data Gotchas](#2-account-data-gotchas)
3. [CPI Edge Cases](#3-cpi-edge-cases)
4. [PDA Pitfalls](#4-pda-pitfalls)
5. [Compute Optimization](#5-compute-optimization)
6. [Security Considerations](#6-security-considerations)
7. [Testing Challenges](#7-testing-challenges)
8. [Debugging Tips](#8-debugging-tips)

---

## 1. Memory & Alignment Issues

### Bytemuck Alignment Requirements

**Problem**: Structs must be properly aligned for bytemuck.

```rust
// BAD: Will panic at runtime
#[repr(C)]
#[derive(Pod, Zeroable)]
pub struct BadStruct {
    pub flag: u8,
    pub value: u64,  // Misaligned! u64 needs 8-byte alignment
}

// GOOD: Properly padded
#[repr(C)]
#[derive(Pod, Zeroable)]
pub struct GoodStruct {
    pub flag: u8,
    pub _padding: [u8; 7],
    pub value: u64,
}
```

**Rule**: After any field smaller than 8 bytes, add padding to reach 8-byte boundary.

### Struct Size Calculation

```rust
// Manual size check
const _: () = assert!(std::mem::size_of::<MyStruct>() == 48);

// Or use compile-time assertion
#[repr(C)]
#[derive(Pod, Zeroable)]
pub struct MyStruct {
    // fields...
}
impl MyStruct {
    pub const LEN: usize = 48;
    const _SIZE_CHECK: () = assert!(core::mem::size_of::<Self>() == Self::LEN);
}
```

### Heap Allocation Gotchas

**Problem**: Using `Vec`, `String`, `Box` without heap allocator.

```rust
// This will fail with no_allocator!()
let data = Vec::new();

// Solution 1: Use fixed-size arrays
let data: [u8; 32] = [0; 32];

// Solution 2: Enable allocator (default)
// Don't use no_allocator!() macro

// Solution 3: Use stack-based alternatives
use arrayvec::ArrayVec;
let data: ArrayVec<u8, 32> = ArrayVec::new();
```

---

## 2. Account Data Gotchas

### Borrow Checker Issues

**Problem**: Multiple borrows of account data.

```rust
// BAD: Will fail - data is borrowed twice
let data1 = account.try_borrow_data()?;
let data2 = account.try_borrow_data()?;

// BAD: Mutable borrow while immutable exists
let data = account.try_borrow_data()?;
let data_mut = account.try_borrow_mut_data()?;

// GOOD: Drop first borrow before second
let value = {
    let data = account.try_borrow_data()?;
    data[0]
};
let mut data_mut = account.try_borrow_mut_data()?;
data_mut[0] = value + 1;
```

### Discriminator Collisions

**Problem**: Different account types with same discriminator.

```rust
// BAD: Both use discriminator 1
pub const VAULT_DISCRIMINATOR: u8 = 1;
pub const USER_DISCRIMINATOR: u8 = 1;

// GOOD: Unique discriminators
pub const VAULT_DISCRIMINATOR: u8 = 1;
pub const USER_DISCRIMINATOR: u8 = 2;

// BETTER: Use enum
#[repr(u8)]
pub enum AccountType {
    Uninitialized = 0,
    Vault = 1,
    User = 2,
    Config = 3,
}
```

### Uninitialized Account Reads

**Problem**: Reading uninitialized account as initialized.

```rust
// BAD: Assumes account is initialized
let vault = Vault::from_account(account)?;

// GOOD: Check initialization first
pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
    let data = account.try_borrow_data()?;

    // Check not empty
    if data.is_empty() {
        return Err(ProgramError::UninitializedAccount);
    }

    // Check discriminator
    if data[0] != VAULT_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }

    // Check size
    if data.len() < Self::LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(bytemuck::from_bytes(&data[..Self::LEN]))
}
```

### Account Reallocation

**Problem**: Changing account size after creation.

```rust
// Pinocchio doesn't have built-in realloc
// Manual approach using system program
fn realloc_account(
    account: &AccountInfo,
    payer: &AccountInfo,
    new_size: usize,
) -> ProgramResult {
    let rent = Rent::get()?;
    let new_minimum_balance = rent.minimum_balance(new_size);
    let current_balance = account.lamports();

    // Transfer additional rent if needed
    if new_minimum_balance > current_balance {
        let diff = new_minimum_balance - current_balance;
        **payer.try_borrow_mut_lamports()? -= diff;
        **account.try_borrow_mut_lamports()? += diff;
    }

    // Realloc (requires program to be owner)
    account.realloc(new_size, false)?;

    Ok(())
}
```

---

## 3. CPI Edge Cases

### Account Order Matters

**Problem**: Wrong account order in CPI.

```rust
// System Program expects: [from, to]
// BAD: Wrong order
CreateAccount {
    from: new_account,  // Should be payer!
    to: payer,          // Should be new_account!
    // ...
}

// GOOD: Correct order
CreateAccount {
    from: payer,
    to: new_account,
    // ...
}
```

### Missing Accounts in CPI

**Problem**: Not passing all required accounts.

```rust
// BAD: Token transfer needs token program
Transfer {
    source,
    destination,
    authority,
    amount,
}.invoke()?;
// Error: Missing token program account!

// GOOD: Ensure token program is in accounts
// (pinocchio-token handles this internally, but custom CPIs need all accounts)
```

### Signer Seeds Lifetime

**Problem**: Seeds going out of scope.

```rust
// BAD: Seeds reference dropped
fn bad_cpi(bump: u8) -> ProgramResult {
    let owner_bytes = [1u8; 32];  // Local variable
    let seeds = &[b"vault", &owner_bytes[..], &[bump]];
    // owner_bytes dropped here!
    Transfer { ... }.invoke_signed(&[seeds])?;
    Ok(())
}

// GOOD: Ensure seeds live long enough
fn good_cpi(owner: &AccountInfo, bump: u8) -> ProgramResult {
    let owner_bytes = owner.key().to_bytes();
    let bump_bytes = [bump];
    let seeds: &[&[u8]] = &[b"vault", &owner_bytes, &bump_bytes];
    Transfer { ... }.invoke_signed(&[seeds])?;
    Ok(())
}
```

### CPI Depth Limit

**Problem**: Exceeding CPI depth (max 4).

```rust
// Program A calls B calls C calls D calls E = ERROR
// Max depth is 4 levels

// Solution: Flatten call hierarchy
// Or combine operations in single CPI
```

---

## 4. PDA Pitfalls

### Bump Consistency

**Problem**: Using wrong bump for PDA operations.

```rust
// BAD: Deriving bump every time (expensive + might differ)
fn withdraw(accounts: &[AccountInfo]) -> ProgramResult {
    let (_, bump) = Pubkey::find_program_address(...);  // 255 iterations worst case
    // Use bump...
}

// GOOD: Store bump in account, verify once
fn withdraw(accounts: &[AccountInfo]) -> ProgramResult {
    let vault = Vault::from_account(vault_account)?;
    // Use stored vault.bump
    Transfer { ... }.invoke_signed(&[&[b"vault", owner, &[vault.bump]]])?;
}
```

### PDA Seed Ordering

**Problem**: Different seed order = different PDA.

```rust
// These produce DIFFERENT PDAs!
let pda1 = Pubkey::find_program_address(&[b"vault", user], program_id);
let pda2 = Pubkey::find_program_address(&[user, b"vault"], program_id);

// Always use consistent ordering
pub const fn vault_seeds<'a>(user: &'a [u8], bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [b"vault", user, bump]
}
```

### PDA vs Keypair Accounts

**Problem**: Treating PDA like a keypair account.

```rust
// PDA accounts CANNOT sign normally
// They can only "sign" via invoke_signed

// BAD: PDA passed as signer in instruction
let accounts = [
    AccountMeta::new(*pda.key(), true),  // true = is_signer, but PDA can't sign!
];

// GOOD: PDA is not marked as signer in instruction
let accounts = [
    AccountMeta::new(*pda.key(), false),  // false = not signer
];
// Then use invoke_signed with seeds
```

---

## 5. Compute Optimization

### Use Lazy Entrypoint for Simple Programs

```rust
// Standard: ~2000 CU overhead for deserialization
entrypoint!(process_instruction);

// Lazy: ~200 CU overhead (10x savings)
lazy_program_entrypoint!(process_instruction);

// Use lazy for programs with 1-3 instructions
```

### Avoid Unnecessary PDA Derivations

```rust
// BAD: Deriving in hot path (expensive)
fn process(accounts: &[AccountInfo]) -> ProgramResult {
    for _ in 0..100 {
        let (pda, bump) = Pubkey::find_program_address(...);
        // ...
    }
}

// GOOD: Derive once, pass bump
fn process(accounts: &[AccountInfo], bump: u8) -> ProgramResult {
    let bump_bytes = [bump];
    for _ in 0..100 {
        let pda = Pubkey::create_program_address(
            &[b"seed", &bump_bytes],
            program_id,
        )?;
        // ...
    }
}
```

### Direct Lamport Manipulation vs CPI

```rust
// CPI Transfer: ~150 CU
Transfer { from, to, lamports }.invoke()?;

// Direct manipulation: ~50 CU (for program-owned accounts)
**from.try_borrow_mut_lamports()? -= lamports;
**to.try_borrow_mut_lamports()? += lamports;
```

### Minimize Account Borrows

```rust
// BAD: Multiple borrows
let data = account.try_borrow_data()?;
let owner = &data[0..32];
drop(data);
let data = account.try_borrow_data()?;
let balance = &data[32..40];

// GOOD: Single borrow
let data = account.try_borrow_data()?;
let owner = &data[0..32];
let balance = &data[32..40];
```

### Use Constants for Offsets

```rust
impl Vault {
    pub const DISCRIMINATOR_OFFSET: usize = 0;
    pub const OWNER_OFFSET: usize = 1;
    pub const BALANCE_OFFSET: usize = 33;

    pub fn get_balance(data: &[u8]) -> u64 {
        u64::from_le_bytes(
            data[Self::BALANCE_OFFSET..Self::BALANCE_OFFSET + 8]
                .try_into()
                .unwrap()
        )
    }
}
```

---

## 6. Security Considerations

### Always Verify Account Ownership

```rust
// BAD: No ownership check
fn process(accounts: &[AccountInfo]) -> ProgramResult {
    let vault = Vault::from_account(&accounts[0])?;
    // Attacker could pass any account!
}

// GOOD: Verify program owns account
fn process(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let vault_account = &accounts[0];
    if vault_account.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let vault = Vault::from_account(vault_account)?;
}
```

### Check All Signers

```rust
// BAD: Trusting authority without signer check
fn withdraw(accounts: &[AccountInfo]) -> ProgramResult {
    let vault = Vault::from_account(&accounts[0])?;
    let authority = &accounts[1];

    if vault.owner != authority.key().to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }
    // Missing: is authority actually signing?
}

// GOOD: Verify signer
fn withdraw(accounts: &[AccountInfo]) -> ProgramResult {
    let vault = Vault::from_account(&accounts[0])?;
    let authority = &accounts[1];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if vault.owner != authority.key().to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }
}
```

### Prevent Integer Overflow

```rust
// BAD: Unchecked arithmetic
vault.balance += amount;  // Could overflow!

// GOOD: Checked arithmetic
vault.balance = vault.balance
    .checked_add(amount)
    .ok_or(ProgramError::ArithmeticOverflow)?;
```

### Validate All PDAs

```rust
// BAD: Trusting PDA without verification
fn process(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let vault = &accounts[0];  // Assumed to be correct PDA
}

// GOOD: Derive and verify
fn process(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let vault = &accounts[0];
    let owner = &accounts[1];

    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"vault", owner.key().as_ref()],
        program_id,
    );

    if vault.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }
}
```

---

## 7. Testing Challenges

### No Anchor Test Framework

```rust
// Use solana-program-test instead
#[cfg(test)]
mod tests {
    use solana_program_test::*;
    use solana_sdk::{signature::Signer, transaction::Transaction};

    #[tokio::test]
    async fn test_initialize() {
        let program_id = Pubkey::new_unique();
        let mut program_test = ProgramTest::new(
            "my_program",
            program_id,
            processor!(process_instruction),
        );

        let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

        // Build and send transaction...
    }
}
```

### Manual Instruction Building

```rust
fn build_initialize_ix(
    program_id: &Pubkey,
    vault: &Pubkey,
    owner: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*vault, false),
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: vec![0], // Discriminator
    }
}
```

---

## 8. Debugging Tips

### Enable Logging

```rust
// Add compute budget for logs
pinocchio::msg!("Debug: value = {}", some_value);

// Log account keys
pinocchio::msg!("Vault: {:?}", vault.key());

// Log hex data
pinocchio::msg!("Data: {:?}", &data[..32]);
```

### Check Transaction Logs

```bash
# View logs for failed transaction
solana logs --url devnet

# Simulate transaction
solana simulate <tx_base58>
```

### Common Error Codes

| Error | Meaning | Likely Cause |
|-------|---------|--------------|
| `0x0` | Success | N/A |
| `0x1` | Generic Error | Check program logic |
| `0x2` | Invalid Argument | Bad instruction data |
| `0x3` | Invalid Account Data | Wrong account type/size |
| `0x4` | Account Already Init | Re-initializing account |
| `0x5` | Insufficient Funds | Not enough lamports |
| `0x6` | Missing Signature | Signer check failed |
| `0x7` | Invalid Seeds | PDA derivation mismatch |

### Simulation Before Sending

```rust
// In tests, simulate first
let result = banks_client
    .simulate_transaction(transaction.clone())
    .await?;

if let Some(err) = result.result.err() {
    println!("Simulation failed: {:?}", err);
    println!("Logs: {:?}", result.simulation_logs);
}
```
