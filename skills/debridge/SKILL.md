---
name: debridge
creator: raunit-dev
description: Complete deBridge Protocol SDK for building cross-chain bridges, message passing, and token transfers on Solana. Use when building cross-chain applications, bridging assets between Solana and EVM chains, or implementing trustless external calls.
---

# deBridge Solana SDK Development Guide

A comprehensive guide for building Solana programs with the deBridge Solana SDK - enabling decentralized cross-chain transfers of arbitrary messages and value between blockchains.

## Overview

deBridge is a cross-chain infrastructure protocol enabling:
- **Cross-Chain Transfers**: Bridge assets between Solana and 20+ EVM chains
- **Message Passing**: Send arbitrary messages across blockchains
- **External Calls**: Execute smart contract calls on destination chains
- **Sub-Second Settlement**: ~2 second median settlement time
- **Capital Efficiency**: Intent-based architecture with 4bps lowest spreads

### Key Features
- 26+ security audits (Halborn, Zokyo, Ackee Blockchain)
- $200K bug bounty on Immunefi
- 100% uptime since launch
- Zero security incidents

## Quick Start

### Installation

Add the SDK to your Anchor/Solana program:

```bash
cargo add --git ssh://git@github.com/debridge-finance/debridge-solana-sdk.git debridge-solana-sdk
```

Or add to `Cargo.toml`:

```toml
[dependencies]
debridge-solana-sdk = { git = "ssh://git@github.com/debridge-finance/debridge-solana-sdk.git" }
```

### Basic Setup (Anchor)

```rust
use anchor_lang::prelude::*;
use debridge_solana_sdk::prelude::*;

declare_id!("YourProgramId11111111111111111111111111111");

#[program]
pub mod my_bridge_program {
    use super::*;

    pub fn send_cross_chain(
        ctx: Context<SendCrossChain>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        // Invoke deBridge send
        debridge_sending::invoke_debridge_send(
            debridge_sending::SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: false,  // Use native SOL for fees
                amount,
                submission_params: None,
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SendCrossChain<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    // Additional accounts passed via remaining_accounts
}
```

## Core Concepts

### 1. Chain IDs

deBridge uses 32-byte chain identifiers for all supported networks:

```rust
use debridge_solana_sdk::chain_ids::*;

// Solana
let solana = SOLANA_CHAIN_ID;  // Solana mainnet

// EVM Chains
let ethereum = ETHEREUM_CHAIN_ID;     // Chain ID: 1
let polygon = POLYGON_CHAIN_ID;       // Chain ID: 137
let bnb = BNB_CHAIN_CHAIN_ID;         // Chain ID: 56
let arbitrum = ARBITRUM_CHAIN_ID;     // Chain ID: 42161
let avalanche = AVALANCHE_CHAIN_ID;   // Chain ID: 43114
let fantom = FANTOM_CHAIN_ID;         // Chain ID: 250
let heco = HECO_CHAIN_ID;             // Chain ID: 128
```

### 2. Program IDs

```rust
use debridge_solana_sdk::{DEBRIDGE_ID, SETTINGS_ID};

// Main deBridge program for sending/claiming
let debridge_program = DEBRIDGE_ID;

// Settings and confirmation storage program
let settings_program = SETTINGS_ID;
```

### 3. Fee Structure

deBridge supports multiple fee payment methods:

```rust
// Native Fee (SOL)
is_use_asset_fee: false  // Pay fees in SOL

// Asset Fee
is_use_asset_fee: true   // Pay fees in the bridged token

// Fee Constants
const BPS_DENOMINATOR: u64 = 10000;  // Basis points divisor
```

### 4. Flags

Control transfer behavior with flags:

```rust
use debridge_solana_sdk::flags::*;

// Available flags (bit positions)
const UNWRAP_ETH: u8 = 0;              // Unwrap to native ETH on destination
const REVERT_IF_EXTERNAL_FAIL: u8 = 1; // Revert if external call fails
const PROXY_WITH_SENDER: u8 = 2;       // Include sender in proxy call
const SEND_HASHED_DATA: u8 = 3;        // Send data as hash
const DIRECT_WALLET_FLOW: u8 = 31;     // Use direct wallet flow

// Setting flags on submission params
let mut flags = [0u8; 32];
flags.set_reserved_flag(UNWRAP_ETH);
flags.set_reserved_flag(REVERT_IF_EXTERNAL_FAIL);
```

## Sending Cross-Chain Transfers

### Basic Token Transfer

```rust
use debridge_solana_sdk::prelude::*;

pub fn send_tokens(
    ctx: Context<SendTokens>,
    amount: u64,
) -> Result<()> {
    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
            target_chain_id: chain_ids::ETHEREUM_CHAIN_ID,
            receiver: recipient_eth_address.to_vec(),
            is_use_asset_fee: false,
            amount,
            submission_params: None,
            referral_code: Some(12345),  // Optional referral
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

### Transfer with Fixed Native Fee

```rust
pub fn send_with_native_fee(
    ctx: Context<Send>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    amount: u64,
) -> Result<()> {
    // Get the fixed fee for the target chain
    let fee = debridge_sending::get_chain_native_fix_fee(
        &target_chain_id,
        ctx.remaining_accounts,
    )?;

    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: false,
            amount,
            submission_params: None,
            referral_code: None,
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

### Transfer with Asset Fee

```rust
pub fn send_with_asset_fee(
    ctx: Context<Send>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    amount: u64,
) -> Result<()> {
    // Check if asset fee is available for this chain
    let is_available = debridge_sending::is_asset_fee_available(
        &target_chain_id,
        ctx.remaining_accounts,
    )?;

    if !is_available {
        return Err(error!(ErrorCode::AssetFeeNotAvailable));
    }

    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: true,  // Use asset for fees
            amount,
            submission_params: None,
            referral_code: None,
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

### Transfer with Exact Amount

```rust
pub fn send_exact_amount(
    ctx: Context<Send>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    exact_receive_amount: u64,
) -> Result<()> {
    // Calculate total amount including fees
    let total_with_fees = debridge_sending::add_all_fees(
        exact_receive_amount,
        &target_chain_id,
        ctx.remaining_accounts,
    )?;

    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: true,
            amount: total_with_fees,
            submission_params: None,
            referral_code: None,
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

### Transfer from PDA (Signed)

```rust
pub fn send_from_pda(
    ctx: Context<SendFromPda>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    amount: u64,
    pda_seeds: Vec<Vec<u8>>,
) -> Result<()> {
    // Use signed variant for PDA-owned tokens
    debridge_sending::invoke_debridge_send_signed(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: false,
            amount,
            submission_params: None,
            referral_code: None,
        },
        ctx.remaining_accounts,
        &pda_seeds,
    )?;

    Ok(())
}
```

## Message Passing

Send messages without token transfers:

```rust
use debridge_solana_sdk::prelude::*;

pub fn send_message(
    ctx: Context<SendMessage>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    message_data: Vec<u8>,
) -> Result<()> {
    // Create submission params with message
    let submission_params = debridge_sending::SendSubmissionParamsInput {
        execution_fee: 0,
        flags: [0u8; 32],
        fallback_address: receiver.clone(),
        external_call_shortcut: compute_keccak256(&message_data),
    };

    // Send message (zero amount)
    debridge_sending::invoke_send_message(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: false,
            amount: 0,  // No token transfer
            submission_params: Some(submission_params),
            referral_code: None,
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

## External Calls

Execute smart contract calls on destination chains:

### Initialize External Call Buffer

```rust
pub fn init_external_call(
    ctx: Context<InitExternalCall>,
    target_chain_id: [u8; 32],
    external_call_data: Vec<u8>,
) -> Result<()> {
    let shortcut = compute_keccak256(&external_call_data);

    debridge_sending::invoke_init_external_call(
        debridge_sending::InitExternalCallIx {
            external_call_len: external_call_data.len() as u32,
            chain_id: target_chain_id,
            external_call_shortcut: shortcut,
            external_call: external_call_data,
        },
        ctx.remaining_accounts,
    )?;

    Ok(())
}
```

### Send with External Call

```rust
pub fn send_with_external_call(
    ctx: Context<SendWithExternalCall>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,  // Target contract address
    amount: u64,
    external_call_data: Vec<u8>,
    execution_fee: u64,  // Fee for executor on destination
) -> Result<()> {
    let shortcut = compute_keccak256(&external_call_data);

    // Set flags for external call behavior
    let mut flags = [0u8; 32];
    flags.set_reserved_flag(flags::REVERT_IF_EXTERNAL_FAIL);

    let submission_params = debridge_sending::SendSubmissionParamsInput {
        execution_fee,
        flags,
        fallback_address: ctx.accounts.fallback.key().to_bytes().to_vec(),
        external_call_shortcut: shortcut,
    };

    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
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
```

## Claim Verification

Verify claims on the receiving side:

### Validate Incoming Claims

```rust
use debridge_solana_sdk::check_claiming::*;

pub fn receive_tokens(ctx: Context<ReceiveTokens>) -> Result<()> {
    // Get and validate the parent claim instruction
    let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()?;

    // Validate submission details
    let validation = SubmissionAccountValidation {
        receiver_validation: Some(ctx.accounts.receiver.key()),
        token_mint_validation: Some(ctx.accounts.token_mint.key()),
        source_chain_id_validation: Some(chain_ids::ETHEREUM_CHAIN_ID),
        ..Default::default()
    };

    claim_ix.validate_submission_account(
        &ctx.accounts.submission_account,
        &validation,
    )?;

    // Proceed with claim logic
    Ok(())
}
```

### Get Submission Key

```rust
pub fn get_claim_info(ctx: Context<ClaimInfo>) -> Result<Pubkey> {
    let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()?;
    let submission_key = claim_ix.get_submission_key()?;
    Ok(submission_key)
}
```

## Fee Queries

### Get Transfer Fees

```rust
// Get base transfer fee (in BPS)
let transfer_fee = debridge_sending::get_transfer_fee(
    ctx.remaining_accounts,
)?;

// Get transfer fee for specific chain
let chain_fee = debridge_sending::get_transfer_fee_for_chain(
    &target_chain_id,
    ctx.remaining_accounts,
)?;

// Get default native fix fee
let default_fee = debridge_sending::get_default_native_fix_fee(
    ctx.remaining_accounts,
)?;

// Get chain-specific native fix fee
let native_fee = debridge_sending::get_chain_native_fix_fee(
    &target_chain_id,
    ctx.remaining_accounts,
)?;

// Get asset fix fee for chain
let asset_fee = debridge_sending::try_get_chain_asset_fix_fee(
    &target_chain_id,
    ctx.remaining_accounts,
)?;
```

### Calculate Total Amount with Fees

```rust
// Add transfer fee to amount
let with_transfer_fee = debridge_sending::add_transfer_fee(
    amount,
    ctx.remaining_accounts,
)?;

// Add all fees (transfer + execution + asset fees)
let total_amount = debridge_sending::add_all_fees(
    amount,
    &target_chain_id,
    ctx.remaining_accounts,
)?;
```

## Chain Support Queries

```rust
// Check if chain is supported
let is_supported = debridge_sending::is_chain_supported(
    &target_chain_id,
    ctx.remaining_accounts,
)?;

// Get chain support info
let chain_info = debridge_sending::get_chain_support_info(
    &target_chain_id,
    ctx.remaining_accounts,
)?;

// Check if asset fee is available
let asset_fee_available = debridge_sending::is_asset_fee_available(
    &target_chain_id,
    ctx.remaining_accounts,
)?;
```

## PDA Derivation

### Bridge Account

```rust
use debridge_solana_sdk::keys::*;

// Find bridge PDA for a token mint
let (bridge_address, bump) = BridgePubkey::find_bridge_address(&token_mint);

// Create with known bump
let bridge_address = BridgePubkey::create_bridge_address(&token_mint, bump)?;
```

### Chain Support Info

```rust
// Find chain support info PDA
let (chain_support_info, bump) = ChainSupportInfoPubkey::find_chain_support_info_address(
    &target_chain_id,
);
```

### Asset Fee Info

```rust
// Find asset fee info PDA
let (asset_fee_info, bump) = AssetFeeInfoPubkey::find_asset_fee_info_address(
    &bridge_pubkey,
    &target_chain_id,
);

// Get default bridge fee address
let default_fee = AssetFeeInfoPubkey::default_bridge_fee_address();
```

### External Call Storage

```rust
// Find external call storage PDA
let (storage, bump) = ExternalCallStoragePubkey::find_external_call_storage_address(
    &shortcut,
    &owner,
);

// Find external call meta PDA
let (meta, bump) = ExternalCallMetaPubkey::find_external_call_meta_address(
    &storage_account,
);
```

## Required Accounts

The SDK requires specific accounts passed via `remaining_accounts`. The account order is important:

| Index | Account | Signer | Writable | Description |
|-------|---------|--------|----------|-------------|
| 0 | Bridge | No | Yes | Bridge account for token |
| 1 | Token Mint | No | No | SPL Token mint |
| 2 | Staking Wallet | No | Yes | Staking rewards wallet |
| 3 | Mint Authority | No | No | Token mint authority |
| 4 | Chain Support Info | No | No | Target chain config |
| 5 | Settings Program | No | No | deBridge settings |
| 6 | SPL Token Program | No | No | Token program |
| 7 | State | No | No | Protocol state |
| 8 | deBridge Program | No | No | Main deBridge program |
| ... | Additional accounts | - | - | Varies by operation |

## TypeScript Client Integration

### Setup

```typescript
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = new Wallet(keypair);
const provider = new AnchorProvider(connection, wallet, {});

// deBridge Program IDs
const DEBRIDGE_PROGRAM_ID = new PublicKey('DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh');
const SETTINGS_PROGRAM_ID = new PublicKey('DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft');
```

### Build Send Transaction

```typescript
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress
} from '@solana/spl-token';

async function buildSendTransaction(
  tokenMint: PublicKey,
  amount: bigint,
  targetChainId: Uint8Array,
  receiver: Uint8Array,
): Promise<Transaction> {
  // Derive required PDAs
  const [bridge] = PublicKey.findProgramAddressSync(
    [Buffer.from('BRIDGE'), tokenMint.toBuffer()],
    DEBRIDGE_PROGRAM_ID
  );

  const [chainSupportInfo] = PublicKey.findProgramAddressSync(
    [Buffer.from('CHAIN_SUPPORT_INFO'), targetChainId],
    SETTINGS_PROGRAM_ID
  );

  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('STATE')],
    DEBRIDGE_PROGRAM_ID
  );

  // Build instruction with remaining accounts
  const instruction = await program.methods
    .sendViaDebridge(
      Array.from(targetChainId),
      Array.from(receiver),
      new BN(amount.toString()),
    )
    .remainingAccounts([
      { pubkey: bridge, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      // ... additional required accounts
    ])
    .instruction();

  return new Transaction().add(instruction);
}
```

### Build External Call Data

```typescript
import { ethers } from 'ethers';
import { keccak256 } from '@ethersproject/keccak256';

function buildExternalCallData(
  targetContract: string,
  functionSig: string,
  params: any[]
): { data: Uint8Array; shortcut: Uint8Array } {
  const iface = new ethers.Interface([functionSig]);
  const calldata = iface.encodeFunctionData(
    functionSig.split('(')[0].replace('function ', ''),
    params
  );

  const data = ethers.getBytes(calldata);
  const shortcut = ethers.getBytes(keccak256(data));

  return { data, shortcut };
}

// Example: ERC20 approve call
const { data, shortcut } = buildExternalCallData(
  '0xTargetContract...',
  'function approve(address spender, uint256 amount)',
  ['0xSpenderAddress...', ethers.parseEther('1000')]
);
```

## Testing

### Anchor Test Setup

```toml
# Anchor.toml
[provider]
cluster = "mainnet"  # Use mainnet for testing with real deBridge

[programs.mainnet]
my_program = "YourProgramId..."
```

### Run Tests

```bash
# Full build and test
cd example_program && anchor build && anchor test

# Test only (skip rebuild)
anchor test --skip-build --skip-deploy
```

### Local Testing Tips

1. **Use Mainnet Fork**: deBridge infrastructure is on mainnet
2. **Mock Remaining Accounts**: Create mock accounts for unit tests
3. **Test Fee Calculations**: Verify fee amounts before sending

## Build Features

The SDK supports different environments via Cargo features:

```toml
# Production (default) - uses hardcoded program IDs
debridge-solana-sdk = { git = "..." }

# Custom environment - uses env vars
debridge-solana-sdk = { git = "...", features = ["env"] }
```

Environment variables for custom networks:
- `DEBRIDGE_PROGRAM_PUBKEY`: Custom deBridge program ID
- `DEBRIDGE_SETTINGS_PROGRAM_PUBKEY`: Custom settings program ID

## Resources

- [deBridge Documentation](https://docs.debridge.com)
- [Solana SDK GitHub](https://github.com/debridge-finance/debridge-solana-sdk)
- [deBridge App](https://app.debridge.finance)
- [Widget Integration](https://docs.debridge.com/widget)
- [API Reference](https://docs.debridge.com/api)

## Skill Structure

```
debridge/
├── SKILL.md                          # This file
├── resources/
│   ├── sdk-api-reference.md          # Complete SDK API reference
│   ├── chain-ids.md                  # Supported chain identifiers
│   ├── program-ids.md                # Program IDs and PDAs
│   └── error-codes.md                # Error types and handling
├── examples/
│   ├── basic-transfer/               # Simple cross-chain transfer
│   ├── external-calls/               # External call execution
│   ├── message-passing/              # Message-only transfers
│   └── fee-configurations/           # Fee payment options
└── docs/
    └── troubleshooting.md            # Common issues and solutions
```
