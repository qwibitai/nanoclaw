/**
 * Pyth Price Validation Patterns
 *
 * Common patterns for validating Pyth prices in Solana programs.
 * Demonstrates best practices for production use.
 *
 * Add to Cargo.toml:
 * [dependencies]
 * anchor-lang = "0.30.1"
 * pyth-solana-receiver-sdk = "0.3.0"
 */

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, Price, PriceUpdateV2};

declare_id!("YourProgramId11111111111111111111111111111111");

/// Pyth Receiver Program ID (mainnet/devnet)
pub const PYTH_RECEIVER_ID: Pubkey =
    solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// ============================================================================
// Price Validation Module
// ============================================================================

pub mod price_validation {
    use super::*;

    /// Configuration for price validation
    #[derive(Clone, Copy)]
    pub struct ValidationConfig {
        /// Maximum age of price in seconds
        pub max_age_secs: u64,
        /// Maximum confidence as basis points (100 = 1%)
        pub max_confidence_bps: u64,
        /// Minimum price (in price units)
        pub min_price: Option<i64>,
        /// Maximum price (in price units)
        pub max_price: Option<i64>,
    }

    impl Default for ValidationConfig {
        fn default() -> Self {
            Self {
                max_age_secs: 60,
                max_confidence_bps: 200, // 2%
                min_price: None,
                max_price: None,
            }
        }
    }

    /// Strict config for high-value operations
    pub fn strict_config() -> ValidationConfig {
        ValidationConfig {
            max_age_secs: 30,
            max_confidence_bps: 100, // 1%
            min_price: Some(0),
            max_price: None,
        }
    }

    /// Lenient config for less critical operations
    pub fn lenient_config() -> ValidationConfig {
        ValidationConfig {
            max_age_secs: 120,
            max_confidence_bps: 500, // 5%
            min_price: None,
            max_price: None,
        }
    }

    /// Validate a price against configuration
    pub fn validate_price(price: &Price, config: &ValidationConfig, clock: &Clock) -> Result<()> {
        // Check staleness
        let current_time = clock.unix_timestamp;
        let price_age = current_time - price.publish_time;

        require!(
            price_age >= 0 && (price_age as u64) <= config.max_age_secs,
            PriceValidationError::PriceTooStale
        );

        // Check confidence ratio
        let confidence_bps = if price.price != 0 {
            ((price.conf as u128) * 10000 / (price.price.unsigned_abs() as u128)) as u64
        } else {
            u64::MAX
        };

        require!(
            confidence_bps <= config.max_confidence_bps,
            PriceValidationError::ConfidenceTooHigh
        );

        // Check price bounds
        if let Some(min) = config.min_price {
            require!(price.price >= min, PriceValidationError::PriceBelowMinimum);
        }

        if let Some(max) = config.max_price {
            require!(price.price <= max, PriceValidationError::PriceAboveMaximum);
        }

        Ok(())
    }

    /// Get a validated price with all checks
    pub fn get_validated_price(
        price_update: &PriceUpdateV2,
        expected_feed_id: &str,
        config: &ValidationConfig,
        clock: &Clock,
    ) -> Result<Price> {
        // Parse expected feed ID
        let feed_id = get_feed_id_from_hex(expected_feed_id)
            .map_err(|_| error!(PriceValidationError::InvalidFeedId))?;

        // Get price with feed verification
        let price = price_update
            .get_price_no_older_than_with_custom_verification(
                clock,
                config.max_age_secs,
                &feed_id,
                &PYTH_RECEIVER_ID,
            )?;

        // Additional validation
        validate_price(&price, config, clock)?;

        Ok(price)
    }
}

// ============================================================================
// Safe Price Calculations
// ============================================================================

pub mod safe_math {
    use super::*;

    /// Price with safety bounds applied
    pub struct SafePrice {
        /// Lower bound of price (price - confidence)
        pub lower: i64,
        /// Mid price
        pub mid: i64,
        /// Upper bound of price (price + confidence)
        pub upper: i64,
        /// Exponent for scaling
        pub exponent: i32,
    }

    impl SafePrice {
        pub fn from_pyth_price(price: &Price) -> Self {
            let conf = price.conf as i64;
            Self {
                lower: price.price.saturating_sub(conf),
                mid: price.price,
                upper: price.price.saturating_add(conf),
                exponent: price.exponent,
            }
        }

        /// Get price for buying (use upper bound - more expensive)
        pub fn buy_price(&self) -> i64 {
            self.upper
        }

        /// Get price for selling (use lower bound - less valuable)
        pub fn sell_price(&self) -> i64 {
            self.lower
        }

        /// Get price with N sigma confidence (N=1 for 68%, N=2 for 95%)
        pub fn price_with_sigma(&self, sigma: u8) -> SafePrice {
            let half_width = (self.upper - self.mid) * (sigma as i64);
            SafePrice {
                lower: self.mid.saturating_sub(half_width),
                mid: self.mid,
                upper: self.mid.saturating_add(half_width),
                exponent: self.exponent,
            }
        }

        /// Convert to u64 with decimals adjustment
        /// Returns None if price is negative
        pub fn to_u64(&self, target_decimals: u8) -> Option<u64> {
            if self.mid < 0 {
                return None;
            }

            let decimal_adjustment = (target_decimals as i32) + self.exponent;
            let scaled = if decimal_adjustment >= 0 {
                (self.mid as u128) * 10u128.pow(decimal_adjustment as u32)
            } else {
                (self.mid as u128) / 10u128.pow((-decimal_adjustment) as u32)
            };

            Some(scaled as u64)
        }
    }

    /// Calculate token value in USD with proper decimal handling
    pub fn calculate_value_usd(
        token_amount: u64,
        token_decimals: u8,
        price: &Price,
        usd_decimals: u8,
    ) -> Result<u64> {
        // Formula: value = amount * price / 10^(token_decimals - price_exponent - usd_decimals)

        let amount = token_amount as u128;
        let price_val = price.price as i128;

        require!(price_val > 0, PriceValidationError::NegativePrice);

        let price_val = price_val as u128;

        // Calculate decimal adjustment
        let exp_adjustment =
            (token_decimals as i32) + price.exponent - (usd_decimals as i32);

        let value = if exp_adjustment >= 0 {
            (amount * price_val) / 10u128.pow(exp_adjustment as u32)
        } else {
            (amount * price_val) * 10u128.pow((-exp_adjustment) as u32)
        };

        Ok(value as u64)
    }

    /// Calculate how many tokens a USD amount can buy
    pub fn calculate_tokens_for_usd(
        usd_amount: u64,
        usd_decimals: u8,
        token_decimals: u8,
        price: &Price,
    ) -> Result<u64> {
        let usd = usd_amount as u128;
        let price_val = price.price as i128;

        require!(price_val > 0, PriceValidationError::NegativePrice);

        let price_val = price_val as u128;

        // Calculate decimal adjustment
        let exp_adjustment =
            (usd_decimals as i32) - price.exponent - (token_decimals as i32);

        let tokens = if exp_adjustment >= 0 {
            (usd * 10u128.pow(exp_adjustment as u32)) / price_val
        } else {
            usd / (price_val * 10u128.pow((-exp_adjustment) as u32))
        };

        Ok(tokens as u64)
    }
}

// ============================================================================
// Multi-Price Validation
// ============================================================================

pub mod multi_price {
    use super::*;

    /// Validate that two prices are from the same timestamp (within tolerance)
    pub fn validate_price_sync(
        price_a: &Price,
        price_b: &Price,
        max_time_diff_secs: i64,
    ) -> Result<()> {
        let time_diff = (price_a.publish_time - price_b.publish_time).abs();
        require!(
            time_diff <= max_time_diff_secs,
            PriceValidationError::PricesNotSynchronized
        );
        Ok(())
    }

    /// Calculate a price ratio (e.g., ETH/BTC from ETH/USD and BTC/USD)
    pub fn calculate_price_ratio(
        numerator_price: &Price,
        denominator_price: &Price,
        result_decimals: u8,
    ) -> Result<u64> {
        require!(
            denominator_price.price > 0,
            PriceValidationError::NegativePrice
        );

        let num = numerator_price.price as i128;
        let denom = denominator_price.price as i128;

        // Adjust for exponent difference
        let exp_diff = numerator_price.exponent - denominator_price.exponent;

        let ratio = if exp_diff >= 0 {
            (num * 10i128.pow(result_decimals as u32) * 10i128.pow(exp_diff as u32)) / denom
        } else {
            (num * 10i128.pow(result_decimals as u32)) / (denom * 10i128.pow((-exp_diff) as u32))
        };

        require!(ratio >= 0, PriceValidationError::NegativePrice);

        Ok(ratio as u64)
    }

    /// TWAP (Time-Weighted Average Price) calculation helper
    /// Combines spot price with EMA for smoother pricing
    pub fn calculate_twap(spot_price: &Price, ema_price: &Price, spot_weight_bps: u16) -> i64 {
        let spot_weight = spot_weight_bps as i128;
        let ema_weight = (10000 - spot_weight_bps) as i128;

        let weighted_price = (spot_price.price as i128 * spot_weight
            + ema_price.price as i128 * ema_weight)
            / 10000;

        weighted_price as i64
    }
}

// ============================================================================
// Error Codes
// ============================================================================

#[error_code]
pub enum PriceValidationError {
    #[msg("Price update is too stale")]
    PriceTooStale,

    #[msg("Price confidence interval is too wide")]
    ConfidenceTooHigh,

    #[msg("Price is below minimum allowed")]
    PriceBelowMinimum,

    #[msg("Price is above maximum allowed")]
    PriceAboveMaximum,

    #[msg("Invalid feed ID format")]
    InvalidFeedId,

    #[msg("Feed ID mismatch")]
    FeedIdMismatch,

    #[msg("Price is negative")]
    NegativePrice,

    #[msg("Prices are not synchronized in time")]
    PricesNotSynchronized,

    #[msg("Price verification failed")]
    VerificationFailed,
}

// ============================================================================
// Example Program Using Validation
// ============================================================================

#[program]
pub mod price_validated_program {
    use super::*;

    /// Example: Swap with strict price validation
    pub fn strict_swap(
        ctx: Context<SwapWithPrice>,
        amount_in: u64,
        min_out: u64,
    ) -> Result<()> {
        let config = price_validation::strict_config();
        let clock = Clock::get()?;

        // Get validated price
        let price = price_validation::get_validated_price(
            &ctx.accounts.price_update,
            "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", // SOL/USD
            &config,
            &clock,
        )?;

        // Use safe price for selling (lower bound)
        let safe_price = safe_math::SafePrice::from_pyth_price(&price);
        let sell_price = safe_price.sell_price();

        msg!("Using validated sell price: {} × 10^{}", sell_price, price.exponent);

        // Calculate output...

        Ok(())
    }

    /// Example: Collateral valuation with 2-sigma confidence
    pub fn value_with_confidence(ctx: Context<SwapWithPrice>) -> Result<()> {
        let config = price_validation::ValidationConfig::default();
        let clock = Clock::get()?;

        let price = price_validation::get_validated_price(
            &ctx.accounts.price_update,
            "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
            &config,
            &clock,
        )?;

        // Get 95% confidence bounds
        let safe_price = safe_math::SafePrice::from_pyth_price(&price);
        let confident_price = safe_price.price_with_sigma(2);

        msg!("Price 95% CI: [{}, {}] × 10^{}",
            confident_price.lower,
            confident_price.upper,
            price.exponent
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SwapWithPrice<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub price_update: Account<'info, PriceUpdateV2>,
}
