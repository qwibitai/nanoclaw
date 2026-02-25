# External Calls Example

Execute smart contract calls on destination chains using deBridge.

## Overview

External calls allow you to:
- Transfer tokens AND execute a contract call atomically
- Call any function on the destination chain
- Set fallback addresses for failed executions
- Configure execution fees for relayers

## Rust Program

### Program Implementation

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint};
use debridge_solana_sdk::prelude::*;
use debridge_solana_sdk::sending::{
    SendIx, SendSubmissionParamsInput, InitExternalCallIx,
    invoke_debridge_send, invoke_init_external_call,
};
use debridge_solana_sdk::flags::{SetReservedFlag, REVERT_IF_EXTERNAL_FAIL, UNWRAP_ETH};

declare_id!("YourProgramId11111111111111111111111111111");

#[program]
pub mod external_calls {
    use super::*;

    /// Initialize external call buffer for large payloads
    ///
    /// Call this before send_with_external_call for payloads > 450 bytes
    pub fn init_external_call_buffer(
        ctx: Context<InitExternalCall>,
        target_chain_id: [u8; 32],
        external_call_data: Vec<u8>,
    ) -> Result<()> {
        // Compute Keccak256 hash of call data
        let shortcut = solana_program::keccak::hash(&external_call_data).to_bytes();

        invoke_init_external_call(
            InitExternalCallIx {
                external_call_len: external_call_data.len() as u32,
                chain_id: target_chain_id,
                external_call_shortcut: shortcut,
                external_call: external_call_data,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Send tokens with an external call on destination
    ///
    /// # Arguments
    /// * `target_chain_id` - Destination chain
    /// * `target_contract` - Contract to call on destination (20 bytes)
    /// * `amount` - Token amount to send
    /// * `external_call_data` - ABI-encoded function call
    /// * `execution_fee` - Fee for executor (in destination native)
    /// * `fallback_address` - Receive tokens if call fails
    pub fn send_with_external_call(
        ctx: Context<SendWithCall>,
        target_chain_id: [u8; 32],
        target_contract: Vec<u8>,
        amount: u64,
        external_call_data: Vec<u8>,
        execution_fee: u64,
        fallback_address: Vec<u8>,
    ) -> Result<()> {
        require!(
            target_contract.len() == 20,
            ErrorCode::InvalidContractAddress
        );
        require!(
            fallback_address.len() == 20,
            ErrorCode::InvalidFallbackAddress
        );

        // Compute shortcut (Keccak256 hash)
        let shortcut = solana_program::keccak::hash(&external_call_data).to_bytes();

        // Configure flags
        let mut flags = [0u8; 32];
        flags.set_reserved_flag(REVERT_IF_EXTERNAL_FAIL);

        let submission_params = SendSubmissionParamsInput {
            execution_fee,
            flags,
            fallback_address,
            external_call_shortcut: shortcut,
        };

        invoke_debridge_send(
            SendIx {
                target_chain_id,
                receiver: target_contract,  // Target contract is the receiver
                is_use_asset_fee: false,
                amount,
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        emit!(ExternalCallSent {
            sender: ctx.accounts.sender.key(),
            target_chain: target_chain_id,
            target_contract: target_contract.try_into().unwrap(),
            amount,
            call_data_hash: shortcut,
        });

        Ok(())
    }

    /// Send tokens and unwrap to native ETH on destination
    pub fn send_and_unwrap_eth(
        ctx: Context<SendWithCall>,
        receiver: Vec<u8>,
        amount: u64,
        fallback_address: Vec<u8>,
    ) -> Result<()> {
        let mut flags = [0u8; 32];
        flags.set_reserved_flag(UNWRAP_ETH);

        let submission_params = SendSubmissionParamsInput {
            execution_fee: 0,
            flags,
            fallback_address,
            external_call_shortcut: [0u8; 32],
        };

        invoke_debridge_send(
            SendIx {
                target_chain_id: chain_ids::ETHEREUM_CHAIN_ID,
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

    /// Swap tokens on destination via Uniswap
    /// This is a common use case - bridging and swapping in one transaction
    pub fn bridge_and_swap(
        ctx: Context<SendWithCall>,
        target_chain_id: [u8; 32],
        uniswap_router: Vec<u8>,
        amount: u64,
        min_output: u64,
        output_token: Vec<u8>,
        recipient: Vec<u8>,
        deadline: u64,
        execution_fee: u64,
    ) -> Result<()> {
        // Build Uniswap swapExactTokensForTokens call data
        // function swapExactTokensForTokens(
        //     uint amountIn,
        //     uint amountOutMin,
        //     address[] calldata path,
        //     address to,
        //     uint deadline
        // )
        let call_data = build_uniswap_swap_calldata(
            amount,
            min_output,
            &output_token,
            &recipient,
            deadline,
        )?;

        let shortcut = solana_program::keccak::hash(&call_data).to_bytes();

        let mut flags = [0u8; 32];
        flags.set_reserved_flag(REVERT_IF_EXTERNAL_FAIL);

        let submission_params = SendSubmissionParamsInput {
            execution_fee,
            flags,
            fallback_address: recipient.clone(),
            external_call_shortcut: shortcut,
        };

        invoke_debridge_send(
            SendIx {
                target_chain_id,
                receiver: uniswap_router,
                is_use_asset_fee: false,
                amount,
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }
}

fn build_uniswap_swap_calldata(
    amount_in: u64,
    amount_out_min: u64,
    output_token: &[u8],
    to: &[u8],
    deadline: u64,
) -> Result<Vec<u8>> {
    // Function selector for swapExactTokensForTokens
    // bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"))
    let selector: [u8; 4] = [0x38, 0xed, 0x17, 0x39];

    let mut data = Vec::new();
    data.extend_from_slice(&selector);

    // Encode parameters (simplified - use proper ABI encoding in production)
    // amountIn
    data.extend_from_slice(&[0u8; 24]);
    data.extend_from_slice(&amount_in.to_be_bytes());

    // amountOutMin
    data.extend_from_slice(&[0u8; 24]);
    data.extend_from_slice(&amount_out_min.to_be_bytes());

    // ... additional encoding

    Ok(data)
}

#[derive(Accounts)]
pub struct InitExternalCall<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendWithCall<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = sender,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct ExternalCallSent {
    pub sender: Pubkey,
    pub target_chain: [u8; 32],
    pub target_contract: [u8; 20],
    pub amount: u64,
    pub call_data_hash: [u8; 32],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Contract address must be 20 bytes")]
    InvalidContractAddress,
    #[msg("Fallback address must be 20 bytes")]
    InvalidFallbackAddress,
    #[msg("Failed to encode call data")]
    CallDataEncodingFailed,
}
```

## TypeScript Client

### Building External Call Data

```typescript
import { ethers } from 'ethers';
import { keccak256 } from '@ethersproject/keccak256';

// Build ERC20 approve call
function buildApproveCalldata(
  spender: string,
  amount: bigint,
): { data: Uint8Array; shortcut: Uint8Array } {
  const iface = new ethers.Interface([
    'function approve(address spender, uint256 amount)',
  ]);

  const calldata = iface.encodeFunctionData('approve', [spender, amount]);
  const data = ethers.getBytes(calldata);
  const shortcut = ethers.getBytes(keccak256(data));

  return { data: new Uint8Array(data), shortcut: new Uint8Array(shortcut) };
}

// Build Uniswap swap call
function buildSwapCalldata(
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  to: string,
  deadline: bigint,
): { data: Uint8Array; shortcut: Uint8Array } {
  const iface = new ethers.Interface([
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)',
  ]);

  const calldata = iface.encodeFunctionData('swapExactTokensForTokens', [
    amountIn,
    amountOutMin,
    path,
    to,
    deadline,
  ]);

  const data = ethers.getBytes(calldata);
  const shortcut = ethers.getBytes(keccak256(data));

  return { data: new Uint8Array(data), shortcut: new Uint8Array(shortcut) };
}

// Build arbitrary function call
function buildCustomCalldata(
  abi: string[],
  functionName: string,
  params: any[],
): { data: Uint8Array; shortcut: Uint8Array } {
  const iface = new ethers.Interface(abi);
  const calldata = iface.encodeFunctionData(functionName, params);

  const data = ethers.getBytes(calldata);
  const shortcut = ethers.getBytes(keccak256(data));

  return { data: new Uint8Array(data), shortcut: new Uint8Array(shortcut) };
}
```

### Send With External Call

```typescript
import { Program, BN } from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';

async function sendWithExternalCall(
  program: Program,
  sender: Keypair,
  tokenMint: PublicKey,
  targetChainId: number[],
  targetContract: string,
  amount: bigint,
  externalCallData: Uint8Array,
  executionFee: bigint,
  fallbackAddress: string,
) {
  // Convert addresses to bytes
  const contractBytes = ethers.getBytes(targetContract);
  const fallbackBytes = ethers.getBytes(fallbackAddress);

  // Derive accounts
  const debridgeAccounts = await deriveDeBridgeAccounts(
    program.provider.connection,
    tokenMint,
    sender.publicKey,
    targetChainId
  );

  // Send transaction
  const tx = await program.methods
    .sendWithExternalCall(
      targetChainId,
      Buffer.from(contractBytes),
      new BN(amount.toString()),
      Buffer.from(externalCallData),
      new BN(executionFee.toString()),
      Buffer.from(fallbackBytes),
    )
    .accounts({
      sender: sender.publicKey,
      tokenMint,
      senderTokenAccount: await getAssociatedTokenAddress(tokenMint, sender.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(buildRemainingAccounts(debridgeAccounts))
    .signers([sender])
    .rpc();

  return tx;
}
```

### Example: Bridge USDC and Swap to WETH

```typescript
async function bridgeAndSwap() {
  const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  // Build swap calldata
  const { data: swapData, shortcut } = buildSwapCalldata(
    100_000_000n,  // 100 USDC in
    50_000_000_000_000_000n,  // Min 0.05 WETH out
    [USDC_ETH, WETH],  // Path
    receiverAddress,  // Recipient
    BigInt(Math.floor(Date.now() / 1000) + 3600),  // 1 hour deadline
  );

  // Send with external call
  const tx = await sendWithExternalCall(
    program,
    wallet,
    USDC_MINT,
    CHAIN_IDS.ETHEREUM,
    UNISWAP_ROUTER,
    100_000_000n,  // 100 USDC
    swapData,
    10_000_000_000_000_000n,  // 0.01 ETH execution fee
    receiverAddress,  // Fallback if swap fails
  );

  console.log('Bridge and swap initiated:', tx);
}
```

## Use Cases

### 1. Bridge and Stake

```typescript
// Bridge tokens and stake on destination DeFi protocol
const { data } = buildCustomCalldata(
  ['function stake(uint256 amount)'],
  'stake',
  [amount]
);

await sendWithExternalCall(
  program,
  sender,
  tokenMint,
  CHAIN_IDS.ETHEREUM,
  stakingContract,
  amount,
  data,
  executionFee,
  fallback
);
```

### 2. Bridge and Provide Liquidity

```typescript
// Add liquidity to Uniswap after bridging
const { data } = buildCustomCalldata(
  ['function addLiquidity(address tokenA, address tokenB, uint amountA, uint amountB, uint minA, uint minB, address to, uint deadline)'],
  'addLiquidity',
  [tokenA, tokenB, amountA, amountB, minA, minB, to, deadline]
);
```

### 3. Cross-Chain NFT Purchase

```typescript
// Bridge funds and buy NFT in one transaction
const { data } = buildCustomCalldata(
  ['function buyNFT(uint256 tokenId)'],
  'buyNFT',
  [tokenId]
);
```

## Flags Reference

| Flag | Value | Description |
|------|-------|-------------|
| `UNWRAP_ETH` | 0 | Unwrap to native ETH |
| `REVERT_IF_EXTERNAL_FAIL` | 1 | Revert entire transaction if call fails |
| `PROXY_WITH_SENDER` | 2 | Include original sender in call |
| `SEND_HASHED_DATA` | 3 | Send data as hash only |

## Notes

1. **Execution Fee**: Set appropriate execution fee to incentivize relayers
2. **Fallback Address**: Always set a fallback to receive tokens if call fails
3. **Call Data Size**: For large payloads (>450 bytes), use `init_external_call_buffer` first
4. **Gas Estimation**: Consider destination chain gas costs when setting fees
