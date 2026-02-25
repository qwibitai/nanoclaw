# Switchboard Rust SDK Reference

Complete API reference for `switchboard-on-demand` Rust crate.

## Installation

Add to `Cargo.toml`:

```toml
[dependencies]
switchboard-on-demand = "0.8.0"
anchor-lang = "0.31.1"
```

## Core Types

### SwitchboardQuote

Account type for oracle quote data.

```rust
use switchboard_on_demand::SwitchboardQuote;

pub struct SwitchboardQuote {
    pub feeds: Vec<FeedData>,
    pub slot: u64,
    pub authority: Pubkey,
}
```

### FeedData

Individual feed data within a quote.

```rust
pub struct FeedData {
    pub id: [u8; 32],    // Feed hash
    pub value: i128,     // Scaled value
    pub slot: u64,       // Update slot
    pub oracle: Pubkey,  // Oracle that provided data
}

impl FeedData {
    /// Get feed ID as hex string
    pub fn hex_id(&self) -> String;

    /// Get feed value (scaled)
    pub fn value(&self) -> i128;
}
```

### PullFeedAccountData

For traditional pull-based feeds.

```rust
use switchboard_on_demand::PullFeedAccountData;

impl PullFeedAccountData {
    /// Parse feed account data
    pub fn parse(account_info: AccountInfo) -> Result<Self>;

    /// Get current value with staleness check
    pub fn get_value(
        &self,
        clock: &Clock,
        max_staleness: u64,
        min_samples: u32,
    ) -> Result<i128>;
}
```

### QuoteVerifier

Verifies oracle quotes with cryptographic proofs.

```rust
use switchboard_on_demand::QuoteVerifier;

impl QuoteVerifier {
    /// Create new verifier
    pub fn new() -> Self;

    /// Set queue for verification
    pub fn queue(self, queue: &Pubkey) -> Self;

    /// Set max age in slots
    pub fn max_age(self, slots: u64) -> Self;

    /// Verify instruction at index
    pub fn verify_instruction_at(self, index: u8) -> Result<Quote>;
}
```

## Utility Functions

### default_queue

Returns the default queue for the current network.

```rust
use switchboard_on_demand::default_queue;

let queue = default_queue(); // Returns mainnet queue
```

### Constants

```rust
use switchboard_on_demand::QUOTE_PROGRAM_ID;

// Quote program ID
pub const QUOTE_PROGRAM_ID: Pubkey = ...;
```

## SwitchboardQuoteExt Trait

Extension trait for SwitchboardQuote.

```rust
use switchboard_on_demand::SwitchboardQuoteExt;

impl SwitchboardQuoteExt for SwitchboardQuote {
    /// Get canonical PDA key for this quote
    fn canonical_key(&self, queue: &Pubkey) -> Pubkey;
}
```

## Integration Patterns

### Basic Oracle Quote Reading

```rust
use anchor_lang::prelude::*;
use switchboard_on_demand::{default_queue, SwitchboardQuoteExt, SwitchboardQuote};

declare_id!("YourProgramId111111111111111111111111111111");

#[program]
pub mod my_program {
    use super::*;

    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        let quote = &ctx.accounts.quote_account;
        let clock = &ctx.accounts.clock;

        // Check staleness
        let staleness = clock.slot.saturating_sub(quote.slot);
        require!(staleness < 100, ErrorCode::StaleFeed);

        // Read feeds
        for feed in quote.feeds.iter() {
            msg!("Feed {}: {}", feed.hex_id(), feed.value());
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    /// Oracle quote account - validated against canonical key
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,

    pub clock: Sysvar<'info, Clock>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Feed is stale")]
    StaleFeed,
}
```

### Traditional Pull Feed Reading

```rust
use anchor_lang::prelude::*;
use switchboard_on_demand::PullFeedAccountData;

pub fn read_pull_feed(ctx: Context<ReadPullFeed>) -> Result<()> {
    let feed_data = PullFeedAccountData::parse(
        ctx.accounts.feed_account.to_account_info()
    )?;

    // Get value with staleness check (100 slots, min 1 sample)
    let value = feed_data.get_value(
        &ctx.accounts.clock,
        100,  // max staleness in slots
        1,    // min samples
    )?;

    msg!("Feed value: {}", value);
    Ok(())
}

#[derive(Accounts)]
pub struct ReadPullFeed<'info> {
    /// CHECK: Validated in instruction
    pub feed_account: AccountInfo<'info>,
    pub clock: Sysvar<'info, Clock>,
}
```

### Quote Verification with Secp256k1

```rust
use anchor_lang::prelude::*;
use switchboard_on_demand::QuoteVerifier;

pub fn verify_and_use_quote(ctx: Context<VerifyQuote>) -> Result<()> {
    // Verify quote instruction at index 0 (secp256k1 verification)
    let quote = QuoteVerifier::new()
        .queue(&ctx.accounts.queue.key())
        .max_age(150) // Max 150 slots old
        .verify_instruction_at(0)?;

    // Use verified quote data
    for feed in quote.feeds.iter() {
        msg!("Verified feed {}: {}", feed.hex_id(), feed.value());
    }

    Ok(())
}

#[derive(Accounts)]
pub struct VerifyQuote<'info> {
    /// CHECK: Queue account
    pub queue: AccountInfo<'info>,

    /// Instructions sysvar for verification
    /// CHECK: Instructions sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}
```

### VRF Randomness

```rust
use anchor_lang::prelude::*;
use switchboard_on_demand::RandomnessAccountData;

pub fn use_randomness(ctx: Context<UseRandomness>) -> Result<()> {
    let randomness_data = RandomnessAccountData::parse(
        ctx.accounts.randomness_account.to_account_info()
    )?;

    // Get random value
    let random_value = randomness_data.get_value(&ctx.accounts.clock)?;

    // Use first byte for coin flip
    let is_heads = random_value[0] % 2 == 0;
    msg!("Coin flip result: {}", if is_heads { "Heads" } else { "Tails" });

    // Use multiple bytes for larger range
    let random_number = u64::from_le_bytes(random_value[0..8].try_into().unwrap());
    msg!("Random number: {}", random_number);

    Ok(())
}

#[derive(Accounts)]
pub struct UseRandomness<'info> {
    /// CHECK: Randomness account
    pub randomness_account: AccountInfo<'info>,
    pub clock: Sysvar<'info, Clock>,
}
```

## Error Handling

### Common Errors

```rust
use switchboard_on_demand::SwitchboardError;

match result {
    Err(SwitchboardError::StaleFeed) => {
        // Feed hasn't been updated recently
    }
    Err(SwitchboardError::InsufficientSamples) => {
        // Not enough oracle responses
    }
    Err(SwitchboardError::InvalidQuote) => {
        // Quote verification failed
    }
    _ => {}
}
```

### Custom Error Handling

```rust
#[error_code]
pub enum MyError {
    #[msg("Switchboard feed is stale")]
    StaleFeed,

    #[msg("Price is outside acceptable range")]
    PriceOutOfRange,

    #[msg("Invalid feed configuration")]
    InvalidFeed,
}

pub fn check_price(value: i128) -> Result<()> {
    require!(value > 0, MyError::PriceOutOfRange);
    require!(value < i128::MAX / 2, MyError::PriceOutOfRange);
    Ok(())
}
```

## Best Practices

### 1. Always Check Staleness

```rust
const MAX_STALENESS_SLOTS: u64 = 100; // ~40 seconds

let staleness = clock.slot.saturating_sub(feed.slot);
require!(staleness < MAX_STALENESS_SLOTS, ErrorCode::StaleFeed);
```

### 2. Validate Feed Identity

```rust
// Store expected feed hash in your program state
let expected_feed_hash: [u8; 32] = [...];

// Verify feed matches expected
require!(feed.id == expected_feed_hash, ErrorCode::InvalidFeed);
```

### 3. Handle Decimal Scaling

```rust
// Switchboard values are typically scaled by 10^18
const PRECISION: i128 = 1_000_000_000_000_000_000;

fn to_decimal(value: i128) -> f64 {
    (value as f64) / (PRECISION as f64)
}

fn from_decimal(value: f64) -> i128 {
    (value * PRECISION as f64) as i128
}
```

### 4. Use Account Constraints

```rust
#[derive(Accounts)]
pub struct MyInstruction<'info> {
    // Validate quote account address
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,

    // Or use constraint
    #[account(
        constraint = feed.owner == &switchboard_program.key()
    )]
    /// CHECK: Feed account
    pub feed: AccountInfo<'info>,

    /// CHECK: Switchboard program
    pub switchboard_program: AccountInfo<'info>,
}
```

## Testing

### Unit Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_staleness_check() {
        let current_slot = 1000;
        let feed_slot = 950;
        let staleness = current_slot - feed_slot;

        assert!(staleness < 100, "Feed should not be stale");
    }

    #[test]
    fn test_decimal_conversion() {
        let scaled_value: i128 = 1_500_000_000_000_000_000; // 1.5
        let decimal = to_decimal(scaled_value);
        assert!((decimal - 1.5).abs() < 0.0001);
    }
}
```

### Integration Tests

```rust
#[tokio::test]
async fn test_read_switchboard_feed() {
    // Setup test environment
    let program_test = ProgramTest::new(
        "my_program",
        my_program::ID,
        processor!(my_program::entry),
    );

    let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

    // Create mock switchboard feed account
    // ... test implementation
}
```
