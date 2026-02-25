# Fee Configuration Examples

Complete guide to deBridge fee options and configurations.

## Fee Types

deBridge has several fee types:

| Fee Type | Description | Payment |
|----------|-------------|---------|
| **Transfer Fee** | Protocol fee (basis points) | Deducted from amount |
| **Native Fix Fee** | Fixed fee in SOL | Paid by sender |
| **Asset Fix Fee** | Fixed fee in bridged token | Deducted from amount |
| **Execution Fee** | Reward for destination executor | Included in transfer |

## Rust Implementation

### Fee Query Functions

```rust
use anchor_lang::prelude::*;
use debridge_solana_sdk::prelude::*;
use debridge_solana_sdk::sending;

declare_id!("YourProgramId11111111111111111111111111111");

#[program]
pub mod fee_examples {
    use super::*;

    /// Get all fee information for a transfer
    pub fn get_fee_breakdown(
        ctx: Context<GetFees>,
        target_chain_id: [u8; 32],
        amount: u64,
    ) -> Result<FeeBreakdown> {
        // Base transfer fee (in BPS)
        let transfer_fee_bps = sending::get_transfer_fee(
            ctx.remaining_accounts,
        )?;

        // Chain-specific transfer fee (may differ)
        let chain_transfer_fee_bps = sending::get_transfer_fee_for_chain(
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        // Fixed native fee (in lamports)
        let native_fix_fee = sending::get_chain_native_fix_fee(
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        // Default native fee (fallback)
        let default_native_fee = sending::get_default_native_fix_fee(
            ctx.remaining_accounts,
        )?;

        // Asset fee availability
        let asset_fee_available = sending::is_asset_fee_available(
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        // Asset fix fee (if available)
        let asset_fix_fee = if asset_fee_available {
            sending::try_get_chain_asset_fix_fee(
                &target_chain_id,
                ctx.remaining_accounts,
            )?.unwrap_or(0)
        } else {
            0
        };

        // Calculate total with fees
        let amount_with_transfer_fee = sending::add_transfer_fee(
            amount,
            ctx.remaining_accounts,
        )?;

        let amount_with_all_fees = sending::add_all_fees(
            amount,
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        Ok(FeeBreakdown {
            transfer_fee_bps,
            chain_transfer_fee_bps,
            native_fix_fee,
            default_native_fee,
            asset_fix_fee,
            asset_fee_available,
            amount_with_transfer_fee,
            amount_with_all_fees,
        })
    }

    /// Send with native fee (SOL)
    pub fn send_with_native_fee(
        ctx: Context<SendTokens>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        // Native fee = pay protocol fees in SOL
        sending::invoke_debridge_send(
            sending::SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: false,  // Use native (SOL)
                amount,
                submission_params: None,
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Send with asset fee (bridged token)
    pub fn send_with_asset_fee(
        ctx: Context<SendTokens>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        // Check if asset fee is available
        let available = sending::is_asset_fee_available(
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        require!(available, ErrorCode::AssetFeeNotAvailable);

        // Asset fee = pay protocol fees in bridged token
        // Fee is deducted from the transfer amount
        sending::invoke_debridge_send(
            sending::SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: true,  // Use bridged asset
                amount,
                submission_params: None,
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Send exact amount (recipient receives exactly this)
    pub fn send_exact_amount(
        ctx: Context<SendTokens>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        exact_receive_amount: u64,
    ) -> Result<()> {
        // Calculate how much to send including all fees
        let send_amount = sending::add_all_fees(
            exact_receive_amount,
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        msg!("Recipient will receive: {}", exact_receive_amount);
        msg!("Total amount to send: {}", send_amount);

        sending::invoke_debridge_send(
            sending::SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: true,
                amount: send_amount,
                submission_params: None,
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Send with execution fee for external calls
    pub fn send_with_execution_fee(
        ctx: Context<SendTokens>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        amount: u64,
        execution_fee: u64,
        external_call_data: Vec<u8>,
    ) -> Result<()> {
        let shortcut = solana_program::keccak::hash(&external_call_data).to_bytes();

        let submission_params = sending::SendSubmissionParamsInput {
            execution_fee,  // Reward for executor
            flags: [0u8; 32],
            fallback_address: receiver.clone(),
            external_call_shortcut: shortcut,
        };

        sending::invoke_debridge_send(
            sending::SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: false,
                amount,
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Estimate total cost for user
    pub fn estimate_total_cost(
        ctx: Context<GetFees>,
        target_chain_id: [u8; 32],
        desired_receive_amount: u64,
        use_asset_fee: bool,
    ) -> Result<TotalCostEstimate> {
        let native_fee = sending::get_chain_native_fix_fee(
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        let token_amount = if use_asset_fee {
            sending::add_all_fees(
                desired_receive_amount,
                &target_chain_id,
                ctx.remaining_accounts,
            )?
        } else {
            sending::add_transfer_fee(
                desired_receive_amount,
                ctx.remaining_accounts,
            )?
        };

        let sol_cost = if use_asset_fee { 0 } else { native_fee };

        Ok(TotalCostEstimate {
            token_amount,
            sol_cost,
            receive_amount: desired_receive_amount,
        })
    }
}

#[derive(Accounts)]
pub struct GetFees<'info> {
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SendTokens<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FeeBreakdown {
    pub transfer_fee_bps: u64,
    pub chain_transfer_fee_bps: u64,
    pub native_fix_fee: u64,
    pub default_native_fee: u64,
    pub asset_fix_fee: u64,
    pub asset_fee_available: bool,
    pub amount_with_transfer_fee: u64,
    pub amount_with_all_fees: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TotalCostEstimate {
    pub token_amount: u64,  // Token amount to send
    pub sol_cost: u64,       // SOL cost (native fee)
    pub receive_amount: u64, // What recipient gets
}

#[error_code]
pub enum ErrorCode {
    #[msg("Asset fee is not available for this chain")]
    AssetFeeNotAvailable,
}
```

## TypeScript Client

### Get Fee Information

```typescript
import { Program, BN } from '@coral-xyz/anchor';

interface FeeBreakdown {
  transferFeeBps: number;
  chainTransferFeeBps: number;
  nativeFixFee: bigint;
  defaultNativeFee: bigint;
  assetFixFee: bigint;
  assetFeeAvailable: boolean;
  amountWithTransferFee: bigint;
  amountWithAllFees: bigint;
}

async function getFeeBreakdown(
  program: Program,
  targetChainId: number[],
  amount: bigint,
): Promise<FeeBreakdown> {
  const debridgeAccounts = await deriveDeBridgeAccounts(
    program.provider.connection,
    targetChainId
  );

  const result = await program.methods
    .getFeeBreakdown(targetChainId, new BN(amount.toString()))
    .accounts({
      payer: program.provider.publicKey,
    })
    .remainingAccounts(buildRemainingAccounts(debridgeAccounts))
    .view();

  return {
    transferFeeBps: result.transferFeeBps.toNumber(),
    chainTransferFeeBps: result.chainTransferFeeBps.toNumber(),
    nativeFixFee: BigInt(result.nativeFixFee.toString()),
    defaultNativeFee: BigInt(result.defaultNativeFee.toString()),
    assetFixFee: BigInt(result.assetFixFee.toString()),
    assetFeeAvailable: result.assetFeeAvailable,
    amountWithTransferFee: BigInt(result.amountWithTransferFee.toString()),
    amountWithAllFees: BigInt(result.amountWithAllFees.toString()),
  };
}
```

### Fee Calculation Utilities

```typescript
const BPS_DENOMINATOR = 10000n;

// Calculate transfer fee from amount
function calculateTransferFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
}

// Calculate amount before fee (given desired receive amount)
function calculateAmountBeforeFee(receiveAmount: bigint, feeBps: number): bigint {
  return (receiveAmount * BPS_DENOMINATOR) / (BPS_DENOMINATOR - BigInt(feeBps));
}

// Format fee for display
function formatFee(fee: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = fee / divisor;
  const fraction = fee % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, '0')}`;
}
```

### Send with Optimal Fee Strategy

```typescript
async function sendWithOptimalFee(
  program: Program,
  sender: Keypair,
  tokenMint: PublicKey,
  targetChainId: number[],
  receiver: string,
  amount: bigint,
): Promise<string> {
  // Get fee info
  const fees = await getFeeBreakdown(program, targetChainId, amount);

  console.log('Fee Breakdown:');
  console.log(`  Transfer Fee: ${fees.transferFeeBps} bps`);
  console.log(`  Native Fix Fee: ${formatFee(fees.nativeFixFee, 9)} SOL`);
  console.log(`  Asset Fee Available: ${fees.assetFeeAvailable}`);

  // Decide on fee strategy
  // Generally, asset fee is better if you have excess tokens
  // Native fee is better if you want to send exact token amount
  const useAssetFee = fees.assetFeeAvailable && amount > fees.assetFixFee * 2n;

  if (useAssetFee) {
    console.log('Using asset fee strategy');
    console.log(`  Amount to send: ${formatFee(fees.amountWithAllFees, 6)}`);
    console.log(`  Recipient receives: ${formatFee(amount, 6)}`);
  } else {
    console.log('Using native fee strategy');
    console.log(`  Token amount: ${formatFee(amount, 6)}`);
    console.log(`  SOL cost: ${formatFee(fees.nativeFixFee, 9)}`);
  }

  // Execute send
  const tx = await program.methods
    .sendWithNativeFee(
      targetChainId,
      Buffer.from(ethers.getBytes(receiver)),
      new BN(amount.toString()),
    )
    .accounts({
      sender: sender.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(buildRemainingAccounts(debridgeAccounts))
    .signers([sender])
    .rpc();

  return tx;
}
```

## Fee Comparison

### Native Fee (SOL) vs Asset Fee

| Aspect | Native Fee | Asset Fee |
|--------|------------|-----------|
| **Payment** | Pay in SOL | Pay in bridged token |
| **User Experience** | Need SOL balance | Only need token balance |
| **Amount Received** | Less (transfer fee) | Less (transfer + asset fee) |
| **Best For** | Small transfers | Large transfers |
| **Availability** | Always available | Not all chains/tokens |

### When to Use Each

**Use Native Fee when:**
- User has SOL balance
- Sending exact token amount is important
- Transfer amount is small

**Use Asset Fee when:**
- User has no SOL (new wallet)
- Sending large amounts
- Convenience over optimization

## Fee Calculation Examples

### Example 1: Basic Transfer

```
Amount: 1000 USDC
Transfer Fee: 4 bps (0.04%)
Native Fix Fee: 0.01 SOL

Native Fee Strategy:
- Pay: 0.01 SOL
- Send: 1000 USDC
- Transfer fee deducted: 0.4 USDC
- Recipient receives: 999.6 USDC

Asset Fee Strategy:
- Pay: 0 SOL
- Send: ~1000.5 USDC (includes fees)
- Recipient receives: 1000 USDC
```

### Example 2: Large Transfer

```
Amount: 100,000 USDC
Transfer Fee: 4 bps
Native Fix Fee: 0.01 SOL
Asset Fix Fee: 5 USDC

Native Fee Strategy:
- Pay: 0.01 SOL
- Send: 100,000 USDC
- Transfer fee: 40 USDC
- Recipient receives: 99,960 USDC
- Total cost: 40 USDC + 0.01 SOL

Asset Fee Strategy:
- Pay: 0 SOL
- Send: 100,045 USDC
- All fees deducted from amount
- Recipient receives: 100,000 USDC
- Total cost: 45 USDC
```

## Notes

1. **BPS_DENOMINATOR**: All basis point fees use 10000 as denominator (1 bps = 0.01%)

2. **Fee Updates**: Fees can change, always query before sending

3. **Chain Differences**: Different chains may have different fee structures

4. **Execution Fee**: Additional fee for external calls, paid to executor

5. **Minimum Amounts**: Some chains have minimum transfer amounts
