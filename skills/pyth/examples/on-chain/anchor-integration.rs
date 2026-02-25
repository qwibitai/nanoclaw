/**
 * Pyth Oracle Integration with Anchor
 *
 * Demonstrates consuming Pyth prices in an Anchor program.
 *
 * Add to Cargo.toml:
 * [dependencies]
 * anchor-lang = "0.30.1"
 * pyth-solana-receiver-sdk = "0.3.0"
 */

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{
    get_feed_id_from_hex, PriceUpdateV2, VerificationLevel,
};

declare_id!("YourProgramId11111111111111111111111111111111");

/// Price feed IDs for common assets
pub mod price_feeds {
    pub const BTC_USD: &str =
        "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    pub const ETH_USD: &str =
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    pub const SOL_USD: &str =
        "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    pub const USDC_USD: &str =
        "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
}

/// Maximum staleness for price updates (60 seconds)
pub const MAX_PRICE_AGE_SECS: u64 = 60;

/// Pyth Receiver Program ID
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

#[program]
pub mod pyth_oracle_example {
    use super::*;

    /// Get price from Pyth oracle with staleness check
    pub fn get_price(ctx: Context<GetPrice>) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let clock = Clock::get()?;

        // Get price with staleness check
        let price = price_update.get_price_no_older_than(&clock, MAX_PRICE_AGE_SECS)?;

        // Log the price data
        msg!("=== Pyth Price Data ===");
        msg!("Price: {} × 10^{}", price.price, price.exponent);
        msg!("Confidence: ±{}", price.conf);
        msg!("Publish time: {}", price.publish_time);

        // Calculate USD value (assuming 6 decimal token)
        let token_amount: u64 = 1_000_000; // 1 token with 6 decimals
        let usd_value = calculate_usd_value(token_amount, 6, &price)?;
        msg!("1 token = ${}", usd_value as f64 / 1_000_000.0);

        Ok(())
    }

    /// Get price with explicit feed ID verification
    pub fn get_verified_price(ctx: Context<GetPrice>, feed_id_hex: String) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let clock = Clock::get()?;

        // Parse the expected feed ID
        let expected_feed_id = get_feed_id_from_hex(&feed_id_hex)
            .map_err(|_| error!(ErrorCode::InvalidFeedId))?;

        // Get price with custom verification
        let price = price_update
            .get_price_no_older_than_with_custom_verification(
                &clock,
                MAX_PRICE_AGE_SECS,
                &expected_feed_id,
                &PYTH_RECEIVER_PROGRAM_ID,
            )?;

        msg!("Verified price: {} × 10^{}", price.price, price.exponent);
        msg!("Feed ID matches: {}", feed_id_hex);

        Ok(())
    }

    /// Get EMA (Exponential Moving Average) price
    pub fn get_ema_price(ctx: Context<GetPrice>) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let clock = Clock::get()?;

        // Get EMA price
        let ema_price = price_update.get_ema_price_no_older_than(&clock, MAX_PRICE_AGE_SECS)?;

        msg!("=== Pyth EMA Price ===");
        msg!("EMA Price: {} × 10^{}", ema_price.price, ema_price.exponent);
        msg!("EMA Confidence: ±{}", ema_price.conf);

        Ok(())
    }

    /// Example: Execute a swap using Pyth price
    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let clock = Clock::get()?;

        // Get current price with staleness check
        let price = price_update.get_price_no_older_than(&clock, MAX_PRICE_AGE_SECS)?;

        // Validate confidence is acceptable (< 2%)
        validate_confidence(&price)?;

        // Calculate output amount using price
        // Using lower bound of confidence interval for safety
        let safe_price = price.price - (price.conf as i64);
        require!(safe_price > 0, ErrorCode::NegativePrice);

        let amount_out = calculate_swap_output(amount_in, safe_price, price.exponent)?;

        // Slippage protection
        require!(
            amount_out >= min_amount_out,
            ErrorCode::SlippageExceeded
        );

        msg!("Swap: {} in -> {} out (min: {})", amount_in, amount_out, min_amount_out);
        msg!("Price used: {} × 10^{}", safe_price, price.exponent);

        // Execute the actual swap logic here...

        Ok(())
    }

    /// Example: Collateral valuation for lending
    pub fn value_collateral(
        ctx: Context<ValueCollateral>,
        collateral_amount: u64,
    ) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let clock = Clock::get()?;

        let price = price_update.get_price_no_older_than(&clock, MAX_PRICE_AGE_SECS)?;

        // Use conservative price (lower bound)
        let conservative_price = price.price - (2 * price.conf as i64);
        require!(conservative_price > 0, ErrorCode::NegativePrice);

        // Calculate collateral value in USD (6 decimals)
        let usd_value = calculate_usd_value(
            collateral_amount,
            9, // SOL has 9 decimals
            &pyth_solana_receiver_sdk::price_update::Price {
                price: conservative_price,
                conf: price.conf,
                exponent: price.exponent,
                publish_time: price.publish_time,
            },
        )?;

        msg!("Collateral amount: {} lamports", collateral_amount);
        msg!("Conservative USD value: ${}", usd_value as f64 / 1_000_000.0);

        // Store or use the valuation...
        ctx.accounts.collateral_state.usd_value = usd_value;

        Ok(())
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Calculate USD value from token amount and price
fn calculate_usd_value(
    token_amount: u64,
    token_decimals: u8,
    price: &pyth_solana_receiver_sdk::price_update::Price,
) -> Result<u64> {
    // Price format: price × 10^exponent
    // We want: token_amount × price in USD with 6 decimals

    let price_value = price.price as i128;
    let token_value = token_amount as i128;

    // Adjust for decimals: token_decimals, price.exponent, and target 6 decimals
    let decimal_adjustment = 6i32 - (token_decimals as i32) - price.exponent;

    let usd_value = if decimal_adjustment >= 0 {
        (token_value * price_value * 10i128.pow(decimal_adjustment as u32)) as u64
    } else {
        (token_value * price_value / 10i128.pow((-decimal_adjustment) as u32)) as u64
    };

    Ok(usd_value)
}

/// Calculate swap output amount
fn calculate_swap_output(amount_in: u64, price: i64, exponent: i32) -> Result<u64> {
    // Simplified calculation - adjust based on your token pair
    let amount_out = (amount_in as i128 * price as i128 / 10i128.pow((-exponent) as u32)) as u64;
    Ok(amount_out)
}

/// Validate that price confidence is acceptable
fn validate_confidence(
    price: &pyth_solana_receiver_sdk::price_update::Price,
) -> Result<()> {
    // Confidence should be less than 2% of price
    let max_conf = (price.price.unsigned_abs() * 2) / 100;
    require!(
        price.conf <= max_conf,
        ErrorCode::ConfidenceTooHigh
    );
    Ok(())
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct GetPrice<'info> {
    /// The Pyth price update account
    pub price_update: Account<'info, PriceUpdateV2>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// The Pyth price update account for the trading pair
    pub price_update: Account<'info, PriceUpdateV2>,

    // Add other accounts needed for swap...
}

#[derive(Accounts)]
pub struct ValueCollateral<'info> {
    pub owner: Signer<'info>,

    /// The Pyth price update for the collateral asset
    pub price_update: Account<'info, PriceUpdateV2>,

    /// State account to store valuation
    #[account(mut)]
    pub collateral_state: Account<'info, CollateralState>,
}

#[account]
pub struct CollateralState {
    pub owner: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub usd_value: u64,
    pub last_update: i64,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid feed ID format")]
    InvalidFeedId,

    #[msg("Price is negative after confidence adjustment")]
    NegativePrice,

    #[msg("Price confidence is too high")]
    ConfidenceTooHigh,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Price is too stale")]
    PriceTooStale,
}
