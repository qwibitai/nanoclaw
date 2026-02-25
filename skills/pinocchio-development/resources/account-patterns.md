# Account Validation Patterns for Pinocchio

Unlike Anchor, Pinocchio requires manual account validation. This guide covers battle-tested patterns for secure and efficient validation.

## Core Principles

1. **Validate early, fail fast** - Check all accounts before any state changes
2. **Single-byte discriminators** - Distinguish account types efficiently
3. **Zero-copy access** - Read/write data in-place when possible
4. **Explicit checks** - Never assume account properties

---

## Pattern 1: Struct-Based Context

The most common pattern - group accounts into a validated struct.

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
};

pub struct InitializeContext<'a, 'b> {
    pub vault: &'a AccountInfo,
    pub owner: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
    pub program_id: &'b Pubkey,
}

impl<'a, 'b> InitializeContext<'a, 'b> {
    pub fn parse(
        program_id: &'b Pubkey,
        accounts: &'a [AccountInfo],
    ) -> Result<Self, ProgramError> {
        // Destructure with length check
        let [vault, owner, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // === SIGNER CHECKS ===
        if !owner.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // === WRITABLE CHECKS ===
        if !vault.is_writable() {
            return Err(ProgramError::InvalidAccountData);
        }

        // === PROGRAM CHECKS ===
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // === PDA DERIVATION CHECK ===
        let (expected_vault, _bump) = Pubkey::find_program_address(
            &[b"vault", owner.key().as_ref()],
            program_id,
        );
        if vault.key() != &expected_vault {
            return Err(ProgramError::InvalidSeeds);
        }

        Ok(Self {
            vault,
            owner,
            system_program,
            program_id,
        })
    }
}
```

---

## Pattern 2: TryFrom Implementation

Cleaner syntax using Rust's standard trait.

```rust
pub struct DepositAccounts<'a> {
    pub vault: &'a AccountInfo,
    pub depositor: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for DepositAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let accounts_iter = &mut accounts.iter();

        let vault = next_account(accounts_iter)?;
        let depositor = next_account(accounts_iter)?;
        let system_program = next_account(accounts_iter)?;

        // Validations
        validate_signer(depositor)?;
        validate_writable(vault)?;
        validate_program(system_program, &pinocchio_system::ID)?;

        Ok(Self {
            vault,
            depositor,
            system_program,
        })
    }
}

// Helper functions
fn next_account<'a>(
    iter: &mut impl Iterator<Item = &'a AccountInfo>,
) -> Result<&'a AccountInfo, ProgramError> {
    iter.next().ok_or(ProgramError::NotEnoughAccountKeys)
}

fn validate_signer(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_signer() {
        Err(ProgramError::MissingRequiredSignature)
    } else {
        Ok(())
    }
}

fn validate_writable(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_writable() {
        Err(ProgramError::InvalidAccountData)
    } else {
        Ok(())
    }
}

fn validate_program(account: &AccountInfo, expected: &Pubkey) -> Result<(), ProgramError> {
    if account.key() != expected {
        Err(ProgramError::IncorrectProgramId)
    } else {
        Ok(())
    }
}
```

---

## Pattern 3: Builder Pattern

Fluent API for complex validation chains.

```rust
pub struct AccountValidator<'a> {
    account: &'a AccountInfo,
    errors: Vec<ProgramError>,
}

impl<'a> AccountValidator<'a> {
    pub fn new(account: &'a AccountInfo) -> Self {
        Self {
            account,
            errors: Vec::new(),
        }
    }

    pub fn is_signer(mut self) -> Self {
        if !self.account.is_signer() {
            self.errors.push(ProgramError::MissingRequiredSignature);
        }
        self
    }

    pub fn is_writable(mut self) -> Self {
        if !self.account.is_writable() {
            self.errors.push(ProgramError::InvalidAccountData);
        }
        self
    }

    pub fn has_owner(mut self, owner: &Pubkey) -> Self {
        if self.account.owner() != owner {
            self.errors.push(ProgramError::IllegalOwner);
        }
        self
    }

    pub fn is_program(mut self, program_id: &Pubkey) -> Self {
        if self.account.key() != program_id {
            self.errors.push(ProgramError::IncorrectProgramId);
        }
        self
    }

    pub fn is_pda(
        mut self,
        seeds: &[&[u8]],
        program_id: &Pubkey,
    ) -> Self {
        let (expected, _) = Pubkey::find_program_address(seeds, program_id);
        if self.account.key() != &expected {
            self.errors.push(ProgramError::InvalidSeeds);
        }
        self
    }

    pub fn has_discriminator(mut self, expected: u8) -> Self {
        if let Ok(data) = self.account.try_borrow_data() {
            if data.is_empty() || data[0] != expected {
                self.errors.push(ProgramError::InvalidAccountData);
            }
        } else {
            self.errors.push(ProgramError::AccountBorrowFailed);
        }
        self
    }

    pub fn build(self) -> Result<&'a AccountInfo, ProgramError> {
        if let Some(err) = self.errors.into_iter().next() {
            Err(err)
        } else {
            Ok(self.account)
        }
    }
}

// Usage
pub fn validate_accounts(accounts: &[AccountInfo]) -> Result<(), ProgramError> {
    let [vault, owner, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let _vault = AccountValidator::new(vault)
        .is_writable()
        .has_discriminator(1)
        .build()?;

    let _owner = AccountValidator::new(owner)
        .is_signer()
        .build()?;

    Ok(())
}
```

---

## Pattern 4: Macro-Based Validation

Reduce boilerplate with custom macros.

```rust
/// Assert a condition or return an error
macro_rules! require {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($err);
        }
    };
}

/// Assert account is a signer
macro_rules! require_signer {
    ($account:expr) => {
        require!(
            $account.is_signer(),
            ProgramError::MissingRequiredSignature
        )
    };
}

/// Assert account is writable
macro_rules! require_writable {
    ($account:expr) => {
        require!(
            $account.is_writable(),
            ProgramError::InvalidAccountData
        )
    };
}

/// Assert account has specific owner
macro_rules! require_owner {
    ($account:expr, $owner:expr) => {
        require!(
            $account.owner() == $owner,
            ProgramError::IllegalOwner
        )
    };
}

/// Assert account is a specific program
macro_rules! require_program {
    ($account:expr, $program:expr) => {
        require!(
            $account.key() == $program,
            ProgramError::IncorrectProgramId
        )
    };
}

/// Assert account matches PDA
macro_rules! require_pda {
    ($account:expr, $seeds:expr, $program_id:expr) => {{
        let (expected, _) = Pubkey::find_program_address($seeds, $program_id);
        require!($account.key() == &expected, ProgramError::InvalidSeeds)
    }};
}

// Usage
fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [vault, depositor, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_writable!(vault);
    require_signer!(depositor);
    require_program!(system_program, &pinocchio_system::ID);
    require_pda!(vault, &[b"vault", depositor.key().as_ref()], program_id);

    // ... instruction logic
    Ok(())
}
```

---

## Account Data Parsing

### Bytemuck (Zero-Copy, Fixed Size)

```rust
use bytemuck::{Pod, Zeroable};

pub const ACCOUNT_DISCRIMINATOR: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MyAccount {
    pub discriminator: u8,
    pub authority: [u8; 32],
    pub value: u64,
    pub bump: u8,
    pub _padding: [u8; 6],  // Align to 8 bytes
}

impl MyAccount {
    pub const LEN: usize = std::mem::size_of::<Self>();

    /// Parse from account (zero-copy read)
    pub fn from_account_info(
        account: &AccountInfo,
    ) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;

        // Size check
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        // Discriminator check
        if data[0] != ACCOUNT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        // Zero-copy cast
        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    /// Parse for mutation (zero-copy write)
    pub fn from_account_info_mut(
        account: &AccountInfo,
    ) -> Result<&mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;

        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        if data[0] != ACCOUNT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }
}
```

### Borsh (Variable Size)

```rust
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize)]
pub struct VariableAccount {
    pub discriminator: u8,
    pub name: String,        // Variable length
    pub data: Vec<u8>,       // Variable length
}

impl VariableAccount {
    pub fn from_account_info(
        account: &AccountInfo,
    ) -> Result<Self, ProgramError> {
        let data = account.try_borrow_data()?;

        // Discriminator check first
        if data.is_empty() || data[0] != 2 {
            return Err(ProgramError::InvalidAccountData);
        }

        Self::try_from_slice(&data)
            .map_err(|_| ProgramError::InvalidAccountData)
    }

    pub fn save(&self, account: &AccountInfo) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        self.serialize(&mut data.as_mut())
            .map_err(|_| ProgramError::InvalidAccountData)?;
        Ok(())
    }
}
```

---

## Common Validation Checks

### Check Account Is Initialized

```rust
fn is_initialized(account: &AccountInfo) -> bool {
    let data = account.try_borrow_data().ok();
    data.map(|d| !d.is_empty() && d[0] != 0).unwrap_or(false)
}
```

### Check Account Is Empty/Uninitialized

```rust
fn is_uninitialized(account: &AccountInfo) -> bool {
    let data = account.try_borrow_data().ok();
    data.map(|d| d.is_empty() || d.iter().all(|&b| b == 0)).unwrap_or(true)
}
```

### Check Account Has Minimum Lamports

```rust
fn has_minimum_balance(
    account: &AccountInfo,
    min_lamports: u64,
) -> Result<(), ProgramError> {
    if account.lamports() < min_lamports {
        return Err(ProgramError::InsufficientFunds);
    }
    Ok(())
}
```

### Check Account Data Size

```rust
fn check_account_size(
    account: &AccountInfo,
    expected_size: usize,
) -> Result<(), ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() != expected_size {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}
```

---

## Security Checklist

Before using an account, verify:

- [ ] **Is signer** (if user authorization required)
- [ ] **Is writable** (if account will be modified)
- [ ] **Owner is correct** (prevent spoofed accounts)
- [ ] **Discriminator matches** (correct account type)
- [ ] **PDA derivation matches** (if PDA account)
- [ ] **Data size is valid** (prevent buffer overflows)
- [ ] **Sufficient lamports** (for rent/operations)
- [ ] **Program ID is correct** (for CPI targets)

---

## Complete Example: Multi-Account Instruction

```rust
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use bytemuck::{Pod, Zeroable};

// Account discriminators
pub const GAME_STATE: u8 = 1;
pub const PLAYER_STATE: u8 = 2;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GameState {
    pub discriminator: u8,
    pub authority: [u8; 32],
    pub total_players: u64,
    pub prize_pool: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PlayerState {
    pub discriminator: u8,
    pub game: [u8; 32],
    pub player: [u8; 32],
    pub score: u64,
    pub bump: u8,
    pub _padding: [u8; 6],
}

pub struct JoinGameContext<'a, 'b> {
    pub game: &'a AccountInfo,
    pub game_state: &'a GameState,
    pub player_account: &'a AccountInfo,
    pub player: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
    pub program_id: &'b Pubkey,
    pub player_bump: u8,
}

impl<'a, 'b> JoinGameContext<'a, 'b> {
    pub fn parse(
        program_id: &'b Pubkey,
        accounts: &'a [AccountInfo],
    ) -> Result<Self, ProgramError> {
        let [game, player_account, player, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // === PLAYER MUST SIGN ===
        if !player.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // === GAME STATE VALIDATION ===
        if game.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        let game_data = game.try_borrow_data()?;
        if game_data.len() < std::mem::size_of::<GameState>() {
            return Err(ProgramError::InvalidAccountData);
        }
        if game_data[0] != GAME_STATE {
            return Err(ProgramError::InvalidAccountData);
        }
        let game_state: &GameState = bytemuck::from_bytes(
            &game_data[..std::mem::size_of::<GameState>()]
        );

        // === PLAYER ACCOUNT PDA VALIDATION ===
        let (expected_player_pda, player_bump) = Pubkey::find_program_address(
            &[b"player", game.key().as_ref(), player.key().as_ref()],
            program_id,
        );
        if player_account.key() != &expected_player_pda {
            return Err(ProgramError::InvalidSeeds);
        }

        // === PLAYER ACCOUNT MUST BE UNINITIALIZED ===
        let player_data = player_account.try_borrow_data()?;
        if !player_data.is_empty() && player_data[0] != 0 {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        drop(player_data);

        // === SYSTEM PROGRAM CHECK ===
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self {
            game,
            game_state,
            player_account,
            player,
            system_program,
            program_id,
            player_bump,
        })
    }
}

pub fn join_game(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let ctx = JoinGameContext::parse(program_id, accounts)?;

    // Create player account PDA
    let space = std::mem::size_of::<PlayerState>() as u64;
    let rent = pinocchio::sysvar::rent::Rent::get()?;
    let lamports = rent.minimum_balance(space as usize);

    pinocchio_system::instructions::CreateAccount {
        from: ctx.player,
        to: ctx.player_account,
        lamports,
        space,
        owner: ctx.program_id,
    }
    .invoke_signed(&[&[
        b"player",
        ctx.game.key().as_ref(),
        ctx.player.key().as_ref(),
        &[ctx.player_bump],
    ]])?;

    // Initialize player state
    let mut player_data = ctx.player_account.try_borrow_mut_data()?;
    let player_state: &mut PlayerState = bytemuck::from_bytes_mut(
        &mut player_data[..std::mem::size_of::<PlayerState>()]
    );

    player_state.discriminator = PLAYER_STATE;
    player_state.game = ctx.game.key().to_bytes();
    player_state.player = ctx.player.key().to_bytes();
    player_state.score = 0;
    player_state.bump = ctx.player_bump;

    // Update game state (increment player count)
    // Note: Would need mutable access to game account
    // This is just showing the validation pattern

    Ok(())
}
```
