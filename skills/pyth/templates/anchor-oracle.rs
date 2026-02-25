/**
 * Pyth Oracle Template for Anchor Programs
 *
 * Production-ready template for consuming Pyth prices in Anchor.
 * Copy this file and customize for your program.
 *
 * Setup:
 * 1. Add to Cargo.toml:
 *    pyth-solana-receiver-sdk = "0.3.0"
 *    anchor-lang = "0.30.1"
 *
 * 2. Import this module in your program
 * 3. Use the provided helpers and account structures
 */

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{
    get_feed_id_from_hex, FeedId, Price, PriceUpdateV2, VerificationLevel,
};

// ============================================================================
// CONSTANTS
// ============================================================================

/// Pyth Receiver Program ID (mainnet/devnet)
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Common price feed IDs
pub mod price_feeds {
    pub const BTC_USD: &str =
        "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    pub const ETH_USD: &str =
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    pub const SOL_USD: &str =
        "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    pub const USDC_USD: &str =
        "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
    pub const USDT_USD: &str =
        "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b";
    pub const JTO_USD: &str =
        "0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2";
    pub const JUP_USD: &str =
        "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996";
}

/// Default maximum price age (60 seconds)
pub const DEFAULT_MAX_PRICE_AGE: u64 = 60;

/// Maximum acceptable confidence (200 basis points = 2%)
pub const MAX_CONFIDENCE_BPS: u64 = 200;

// ============================================================================
// PRICE VALIDATION
// ============================================================================

/// Configuration for price validation
#[derive(Clone, Copy, Debug, AnchorSerialize, AnchorDeserialize)]
pub struct PriceValidationConfig {
    /// Maximum age of price in seconds
    pub max_age_secs: u64,
    /// Maximum confidence in basis points
    pub max_confidence_bps: u64,
    /// Expected feed ID (optional)
    pub expected_feed_id: Option<[u8; 32]>,
}

impl Default for PriceValidationConfig {
    fn default() -> Self {
        Self {
            max_age_secs: DEFAULT_MAX_PRICE_AGE,
            max_confidence_bps: MAX_CONFIDENCE_BPS,
            expected_feed_id: None,
        }
    }
}

impl PriceValidationConfig {
    /// Create strict config for high-value operations
    pub fn strict() -> Self {
        Self {
            max_age_secs: 30,
            max_confidence_bps: 100, // 1%
            expected_feed_id: None,
        }
    }

    /// Create lenient config for less critical operations
    pub fn lenient() -> Self {
        Self {
            max_age_secs: 120,
            max_confidence_bps: 500, // 5%
            expected_feed_id: None,
        }
    }

    /// Set expected feed ID from hex string
    pub fn with_feed_id(mut self, feed_id_hex: &str) -> Result<Self> {
        let feed_id = get_feed_id_from_hex(feed_id_hex)
            .map_err(|_| error!(OracleError::InvalidFeedId))?;
        self.expected_feed_id = Some(feed_id);
        Ok(self)
    }
}

/// Validated price with bounds
#[derive(Clone, Copy, Debug)]
pub struct ValidatedPrice {
    /// Raw price value
    pub price: i64,
    /// Confidence interval
    pub conf: u64,
    /// Price exponent
    pub exponent: i32,
    /// Publish timestamp
    pub publish_time: i64,
    /// Lower bound (price - conf)
    pub lower_bound: i64,
    /// Upper bound (price + conf)
    pub upper_bound: i64,
}

impl ValidatedPrice {
    /// Create from Pyth Price
    pub fn from_price(price: &Price) -> Self {
        let conf_i64 = price.conf as i64;
        Self {
            price: price.price,
            conf: price.conf,
            exponent: price.exponent,
            publish_time: price.publish_time,
            lower_bound: price.price.saturating_sub(conf_i64),
            upper_bound: price.price.saturating_add(conf_i64),
        }
    }

    /// Get conservative price for selling (lower bound)
    pub fn sell_price(&self) -> i64 {
        self.lower_bound
    }

    /// Get conservative price for buying (upper bound)
    pub fn buy_price(&self) -> i64 {
        self.upper_bound
    }

    /// Get price with N-sigma confidence interval
    pub fn price_with_sigma(&self, sigma: u8) -> (i64, i64) {
        let half_width = (self.conf as i64) * (sigma as i64);
        (
            self.price.saturating_sub(half_width),
            self.price.saturating_add(half_width),
        )
    }

    /// Convert to USD value (6 decimals)
    pub fn to_usd_value(&self, token_amount: u64, token_decimals: u8) -> Result<u64> {
        calculate_usd_value(token_amount, token_decimals, self.price, self.exponent)
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Get and validate a price from a PriceUpdateV2 account
pub fn get_validated_price(
    price_update: &PriceUpdateV2,
    config: &PriceValidationConfig,
    clock: &Clock,
) -> Result<ValidatedPrice> {
    // Get price with staleness check
    let price = if let Some(feed_id) = config.expected_feed_id {
        price_update.get_price_no_older_than_with_custom_verification(
            clock,
            config.max_age_secs,
            &feed_id,
            &PYTH_RECEIVER_PROGRAM_ID,
        )?
    } else {
        price_update.get_price_no_older_than(clock, config.max_age_secs)?
    };

    // Validate confidence
    validate_confidence(&price, config.max_confidence_bps)?;

    Ok(ValidatedPrice::from_price(&price))
}

/// Validate that confidence is within acceptable bounds
pub fn validate_confidence(price: &Price, max_bps: u64) -> Result<()> {
    if price.price == 0 {
        return Err(error!(OracleError::ZeroPrice));
    }

    let conf_bps = ((price.conf as u128) * 10000) / (price.price.unsigned_abs() as u128);

    require!(
        conf_bps <= max_bps as u128,
        OracleError::ConfidenceTooHigh
    );

    Ok(())
}

/// Calculate USD value from token amount and price
pub fn calculate_usd_value(
    token_amount: u64,
    token_decimals: u8,
    price: i64,
    price_exponent: i32,
) -> Result<u64> {
    require!(price > 0, OracleError::NegativePrice);

    let amount = token_amount as u128;
    let price_val = price as u128;

    // Target: 6 decimal USD value
    // Formula: amount * price * 10^(6 - token_decimals - price_exponent)
    let exp_adjustment = 6i32 - (token_decimals as i32) - price_exponent;

    let value = if exp_adjustment >= 0 {
        amount * price_val * 10u128.pow(exp_adjustment as u32)
    } else {
        (amount * price_val) / 10u128.pow((-exp_adjustment) as u32)
    };

    Ok(value as u64)
}

/// Calculate token amount from USD value and price
pub fn calculate_tokens_for_usd(
    usd_amount: u64,
    usd_decimals: u8,
    token_decimals: u8,
    price: i64,
    price_exponent: i32,
) -> Result<u64> {
    require!(price > 0, OracleError::NegativePrice);

    let usd = usd_amount as u128;
    let price_val = price as u128;

    let exp_adjustment = (usd_decimals as i32) - price_exponent - (token_decimals as i32);

    let tokens = if exp_adjustment >= 0 {
        (usd * 10u128.pow(exp_adjustment as u32)) / price_val
    } else {
        usd / (price_val * 10u128.pow((-exp_adjustment) as u32))
    };

    Ok(tokens as u64)
}

/// Parse feed ID from hex string
pub fn parse_feed_id(feed_id_hex: &str) -> Result<FeedId> {
    get_feed_id_from_hex(feed_id_hex).map_err(|_| error!(OracleError::InvalidFeedId))
}

// ============================================================================
// ACCOUNT STRUCTURES
// ============================================================================

/// Accounts for a single price operation
#[derive(Accounts)]
pub struct SinglePriceContext<'info> {
    /// The Pyth price update account
    pub price_update: Account<'info, PriceUpdateV2>,
}

/// Accounts for dual price operation (e.g., swaps)
#[derive(Accounts)]
pub struct DualPriceContext<'info> {
    /// Price update for the input asset
    pub input_price_update: Account<'info, PriceUpdateV2>,
    /// Price update for the output asset
    pub output_price_update: Account<'info, PriceUpdateV2>,
}

/// Accounts for a swap with price validation
#[derive(Accounts)]
pub struct SwapWithOracle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Price update for the input token
    pub input_price: Account<'info, PriceUpdateV2>,

    /// Price update for the output token
    pub output_price: Account<'info, PriceUpdateV2>,

    // Add your token accounts, pool accounts, etc.
}

/// Accounts for collateral valuation
#[derive(Accounts)]
pub struct ValueCollateral<'info> {
    pub owner: Signer<'info>,

    /// Price update for the collateral asset
    pub collateral_price: Account<'info, PriceUpdateV2>,

    /// State account to store valuation
    #[account(mut)]
    pub position: Account<'info, Position>,
}

/// Example position state
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub usd_value: u64,
    pub last_price_update: i64,
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}

// ============================================================================
// ERROR CODES
// ============================================================================

#[error_code]
pub enum OracleError {
    #[msg("Invalid feed ID format")]
    InvalidFeedId,

    #[msg("Feed ID mismatch")]
    FeedIdMismatch,

    #[msg("Price is too stale")]
    PriceTooStale,

    #[msg("Price confidence is too high")]
    ConfidenceTooHigh,

    #[msg("Price is zero")]
    ZeroPrice,

    #[msg("Price is negative")]
    NegativePrice,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Prices not synchronized")]
    PricesNotSynchronized,

    #[msg("Insufficient collateral")]
    InsufficientCollateral,

    #[msg("Math overflow")]
    MathOverflow,
}

// ============================================================================
// EXAMPLE PROGRAM
// ============================================================================

declare_id!("YourProgramId11111111111111111111111111111111");

#[program]
pub mod oracle_example {
    use super::*;

    /// Example: Get price with default validation
    pub fn get_price(ctx: Context<SinglePriceContext>) -> Result<()> {
        let config = PriceValidationConfig::default();
        let clock = Clock::get()?;

        let price = get_validated_price(&ctx.accounts.price_update, &config, &clock)?;

        msg!("Price: {} × 10^{}", price.price, price.exponent);
        msg!("Confidence: ±{}", price.conf);
        msg!("Bounds: [{}, {}]", price.lower_bound, price.upper_bound);

        Ok(())
    }

    /// Example: Get price with strict validation and feed ID check
    pub fn get_verified_price(
        ctx: Context<SinglePriceContext>,
        feed_id_hex: String,
    ) -> Result<()> {
        let config = PriceValidationConfig::strict()
            .with_feed_id(&feed_id_hex)?;
        let clock = Clock::get()?;

        let price = get_validated_price(&ctx.accounts.price_update, &config, &clock)?;

        msg!("Verified price: {} × 10^{}", price.price, price.exponent);

        Ok(())
    }

    /// Example: Swap with price-based slippage protection
    pub fn swap_with_oracle(
        ctx: Context<SwapWithOracle>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let config = PriceValidationConfig::strict();

        // Get input token price
        let input_price = get_validated_price(
            &ctx.accounts.input_price,
            &config,
            &clock,
        )?;

        // Get output token price
        let output_price = get_validated_price(
            &ctx.accounts.output_price,
            &config,
            &clock,
        )?;

        // Use conservative prices for safety
        // Selling input: use lower bound
        // Buying output: use upper bound
        let input_usd = calculate_usd_value(
            amount_in,
            9, // Adjust for your token
            input_price.sell_price(),
            input_price.exponent,
        )?;

        let expected_out = calculate_tokens_for_usd(
            input_usd,
            6,
            9, // Adjust for your token
            output_price.buy_price(),
            output_price.exponent,
        )?;

        msg!("Input value (USD): {}", input_usd);
        msg!("Expected output: {}", expected_out);

        // Slippage check
        require!(
            expected_out >= min_amount_out,
            OracleError::SlippageExceeded
        );

        // Execute swap logic...

        Ok(())
    }

    /// Example: Value collateral position
    pub fn update_collateral_value(ctx: Context<ValueCollateral>) -> Result<()> {
        let clock = Clock::get()?;
        let config = PriceValidationConfig::default();

        let price = get_validated_price(
            &ctx.accounts.collateral_price,
            &config,
            &clock,
        )?;

        // Use conservative valuation (2-sigma lower bound)
        let (lower_2sigma, _) = price.price_with_sigma(2);

        let usd_value = calculate_usd_value(
            ctx.accounts.position.collateral_amount,
            9, // SOL decimals
            lower_2sigma,
            price.exponent,
        )?;

        // Update position
        ctx.accounts.position.usd_value = usd_value;
        ctx.accounts.position.last_price_update = clock.unix_timestamp;

        msg!("Updated collateral value: ${}", usd_value as f64 / 1_000_000.0);

        Ok(())
    }
}
