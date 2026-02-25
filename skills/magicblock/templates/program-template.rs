// MagicBlock Ephemeral Rollups Program Template
// Copy this file to programs/<name>/src/lib.rs

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit_accounts, delegate_account, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegationProgram;
use ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID;

// IMPORTANT: Replace with your program ID
declare_id!("YourProgramId111111111111111111111111111111");

// ============================================================================
// PROGRAM
// ============================================================================

#[ephemeral] // Required: enables Ephemeral Rollup support
#[program]
pub mod my_program {
    use super::*;

    // ========================================================================
    // BASE LAYER INSTRUCTIONS
    // ========================================================================

    /// Initialize account on Solana base layer
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.payer.key();
        state.value = 0;
        state.bump = ctx.bumps.state;
        msg!("State initialized");
        Ok(())
    }

    /// Delegate account to Ephemeral Rollup
    #[delegate] // Auto-injects delegation accounts
    pub fn delegate(ctx: Context<Delegate>) -> Result<()> {
        msg!("Account delegated to ER");
        Ok(())
    }

    // ========================================================================
    // EPHEMERAL ROLLUP INSTRUCTIONS
    // ========================================================================

    /// Execute on Ephemeral Rollup (fast, gasless)
    pub fn increment(ctx: Context<Execute>) -> Result<()> {
        ctx.accounts.state.value += 1;
        msg!("Value: {}", ctx.accounts.state.value);
        Ok(())
    }

    /// Execute with parameter
    pub fn set_value(ctx: Context<Execute>, new_value: u64) -> Result<()> {
        ctx.accounts.state.value = new_value;
        msg!("Value set to: {}", new_value);
        Ok(())
    }

    /// Commit state to base layer without undelegating
    pub fn commit(ctx: Context<Commit>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.state.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        msg!("State committed");
        Ok(())
    }

    /// Undelegate and return ownership to program
    #[commit] // Auto-injects commit + undelegate accounts
    pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
        msg!("Account undelegated");
        Ok(())
    }
}

// ============================================================================
// STATE
// ============================================================================

#[account]
pub struct State {
    pub authority: Pubkey,
    pub value: u64,
    pub bump: u8,
}

impl State {
    pub const SIZE: usize = 8  // discriminator
        + 32  // authority
        + 8   // value
        + 1;  // bump
}

// ============================================================================
// CONTEXTS
// ============================================================================

/// Initialize on base layer
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = State::SIZE,
        seeds = [b"state", payer.key().as_ref()],
        bump
    )]
    pub state: Account<'info, State>,

    pub system_program: Program<'info, System>,
}

/// Delegate to ER
#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Account to be delegated
    #[account(
        mut,
        seeds = [b"state", payer.key().as_ref()],
        bump,
        del // Required: marks account for delegation
    )]
    pub state: AccountInfo<'info>,

    pub delegation_program: Program<'info, DelegationProgram>,
}

/// Execute on ER
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"state", payer.key().as_ref()],
        bump = state.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub state: Account<'info, State>,

    pub authority: Signer<'info>,
}

/// Commit state
#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub state: Account<'info, State>,

    /// CHECK: Magic context
    pub magic_context: AccountInfo<'info>,

    /// CHECK: Magic program
    pub magic_program: AccountInfo<'info>,
}

/// Undelegate from ER
#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Account to be undelegated
    #[account(mut)]
    pub state: AccountInfo<'info>,

    /// CHECK: Magic context
    pub magic_context: AccountInfo<'info>,

    /// CHECK: Magic program
    pub magic_program: AccountInfo<'info>,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
}
