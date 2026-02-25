# Message Passing Example

Send arbitrary messages across chains without token transfers using deBridge.

## Overview

deBridge Message Passing enables:
- Cross-chain communication without token transfers
- Arbitrary data transmission between blockchains
- Trustless message verification on destination
- Integration with cross-chain governance, oracles, etc.

## Rust Program

### Message Sender

```rust
use anchor_lang::prelude::*;
use debridge_solana_sdk::prelude::*;
use debridge_solana_sdk::sending::{SendIx, SendSubmissionParamsInput, invoke_send_message};
use debridge_solana_sdk::flags::{SetReservedFlag, REVERT_IF_EXTERNAL_FAIL};

declare_id!("YourProgramId11111111111111111111111111111");

#[program]
pub mod message_passing {
    use super::*;

    /// Send a message to another chain
    ///
    /// # Arguments
    /// * `target_chain_id` - Destination chain
    /// * `receiver` - Contract to receive the message (20 bytes for EVM)
    /// * `message` - Arbitrary message data
    /// * `execution_fee` - Fee for message delivery
    pub fn send_message(
        ctx: Context<SendMessage>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        message: Vec<u8>,
        execution_fee: u64,
    ) -> Result<()> {
        require!(!message.is_empty(), ErrorCode::EmptyMessage);

        // Compute message hash
        let message_hash = solana_program::keccak::hash(&message).to_bytes();

        // Configure flags
        let mut flags = [0u8; 32];
        flags.set_reserved_flag(REVERT_IF_EXTERNAL_FAIL);

        let submission_params = SendSubmissionParamsInput {
            execution_fee,
            flags,
            fallback_address: vec![], // No fallback for messages
            external_call_shortcut: message_hash,
        };

        invoke_send_message(
            SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: false,
                amount: 0,  // No token transfer
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        emit!(MessageSent {
            sender: ctx.accounts.sender.key(),
            target_chain: target_chain_id,
            message_hash,
            nonce: ctx.accounts.nonce_counter.nonce,
        });

        // Increment nonce
        ctx.accounts.nonce_counter.nonce += 1;

        Ok(())
    }

    /// Send a governance proposal cross-chain
    pub fn send_governance_proposal(
        ctx: Context<SendGovernance>,
        target_chain_id: [u8; 32],
        governance_contract: Vec<u8>,
        proposal_id: u64,
        actions: Vec<GovernanceAction>,
    ) -> Result<()> {
        // Serialize proposal data
        let proposal_data = serialize_proposal(proposal_id, &actions)?;
        let message_hash = solana_program::keccak::hash(&proposal_data).to_bytes();

        let mut flags = [0u8; 32];
        flags.set_reserved_flag(REVERT_IF_EXTERNAL_FAIL);

        let submission_params = SendSubmissionParamsInput {
            execution_fee: 0,
            flags,
            fallback_address: vec![],
            external_call_shortcut: message_hash,
        };

        invoke_send_message(
            SendIx {
                target_chain_id,
                receiver: governance_contract,
                is_use_asset_fee: false,
                amount: 0,
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }

    /// Send oracle price update
    pub fn send_oracle_update(
        ctx: Context<SendOracle>,
        target_chain_id: [u8; 32],
        oracle_contract: Vec<u8>,
        price_feed_id: [u8; 32],
        price: i128,
        confidence: u64,
        timestamp: i64,
    ) -> Result<()> {
        // Serialize oracle data
        let oracle_data = serialize_oracle_update(
            price_feed_id,
            price,
            confidence,
            timestamp,
        )?;

        let message_hash = solana_program::keccak::hash(&oracle_data).to_bytes();

        let submission_params = SendSubmissionParamsInput {
            execution_fee: 0,
            flags: [0u8; 32],
            fallback_address: vec![],
            external_call_shortcut: message_hash,
        };

        invoke_send_message(
            SendIx {
                target_chain_id,
                receiver: oracle_contract,
                is_use_asset_fee: false,
                amount: 0,
                submission_params: Some(submission_params),
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        Ok(())
    }
}

fn serialize_proposal(proposal_id: u64, actions: &[GovernanceAction]) -> Result<Vec<u8>> {
    let mut data = Vec::new();

    // Message type identifier
    data.push(0x01); // GOVERNANCE_PROPOSAL

    // Proposal ID
    data.extend_from_slice(&proposal_id.to_be_bytes());

    // Number of actions
    data.extend_from_slice(&(actions.len() as u32).to_be_bytes());

    // Serialize each action
    for action in actions {
        data.extend_from_slice(&action.target);
        data.extend_from_slice(&action.value.to_be_bytes());
        data.extend_from_slice(&(action.calldata.len() as u32).to_be_bytes());
        data.extend_from_slice(&action.calldata);
    }

    Ok(data)
}

fn serialize_oracle_update(
    feed_id: [u8; 32],
    price: i128,
    confidence: u64,
    timestamp: i64,
) -> Result<Vec<u8>> {
    let mut data = Vec::new();

    // Message type identifier
    data.push(0x02); // ORACLE_UPDATE

    // Feed ID
    data.extend_from_slice(&feed_id);

    // Price (as bytes)
    data.extend_from_slice(&price.to_be_bytes());

    // Confidence
    data.extend_from_slice(&confidence.to_be_bytes());

    // Timestamp
    data.extend_from_slice(&timestamp.to_be_bytes());

    Ok(data)
}

#[derive(Accounts)]
pub struct SendMessage<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        seeds = [b"nonce", sender.key().as_ref()],
        bump,
    )]
    pub nonce_counter: Account<'info, NonceCounter>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendGovernance<'info> {
    #[account(mut)]
    pub governance_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendOracle<'info> {
    #[account(mut)]
    pub oracle_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct NonceCounter {
    pub nonce: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GovernanceAction {
    pub target: [u8; 20],   // Target contract
    pub value: u64,          // ETH value
    pub calldata: Vec<u8>,   // Function call data
}

#[event]
pub struct MessageSent {
    pub sender: Pubkey,
    pub target_chain: [u8; 32],
    pub message_hash: [u8; 32],
    pub nonce: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Message cannot be empty")]
    EmptyMessage,
    #[msg("Invalid governance action")]
    InvalidGovernanceAction,
}
```

### Message Receiver (Solana)

```rust
use anchor_lang::prelude::*;
use debridge_solana_sdk::check_claiming::*;

#[program]
pub mod message_receiver {
    use super::*;

    /// Receive and process a cross-chain message
    pub fn receive_message(
        ctx: Context<ReceiveMessage>,
        expected_source_chain: [u8; 32],
        expected_sender: Vec<u8>,
    ) -> Result<()> {
        // Validate the claim instruction
        let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()?;

        let validation = SubmissionAccountValidation {
            source_chain_id_validation: Some(expected_source_chain),
            native_sender_validation: Some(expected_sender),
            receiver_validation: Some(ctx.accounts.receiver.key()),
            ..Default::default()
        };

        claim_ix.validate_submission_account(
            &ctx.accounts.submission_account,
            &validation,
        )?;

        // Message is now verified, process it
        emit!(MessageReceived {
            source_chain: expected_source_chain,
            receiver: ctx.accounts.receiver.key(),
        });

        Ok(())
    }

    /// Receive governance proposal
    pub fn receive_governance(
        ctx: Context<ReceiveGovernance>,
        source_chain: [u8; 32],
        authorized_sender: Vec<u8>,
    ) -> Result<()> {
        let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()?;

        let validation = SubmissionAccountValidation {
            source_chain_id_validation: Some(source_chain),
            native_sender_validation: Some(authorized_sender),
            ..Default::default()
        };

        claim_ix.validate_submission_account(
            &ctx.accounts.submission_account,
            &validation,
        )?;

        // Process governance action
        // The message data would be parsed and executed here

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReceiveMessage<'info> {
    pub receiver: Signer<'info>,
    /// CHECK: Validated in instruction
    pub submission_account: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ReceiveGovernance<'info> {
    pub governance_executor: Signer<'info>,
    /// CHECK: Validated in instruction
    pub submission_account: AccountInfo<'info>,
}

#[event]
pub struct MessageReceived {
    pub source_chain: [u8; 32],
    pub receiver: Pubkey,
}
```

## TypeScript Client

### Send Message

```typescript
import { Program, BN } from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import { keccak256 } from '@ethersproject/keccak256';

async function sendMessage(
  program: Program,
  sender: Keypair,
  targetChainId: number[],
  receiver: string,
  message: Uint8Array,
  executionFee: bigint,
) {
  const receiverBytes = ethers.getBytes(receiver);

  const debridgeAccounts = await deriveDeBridgeAccounts(
    program.provider.connection,
    sender.publicKey,
    targetChainId
  );

  const [nonceCounter] = PublicKey.findProgramAddressSync(
    [Buffer.from('nonce'), sender.publicKey.toBuffer()],
    program.programId
  );

  const tx = await program.methods
    .sendMessage(
      targetChainId,
      Buffer.from(receiverBytes),
      Buffer.from(message),
      new BN(executionFee.toString()),
    )
    .accounts({
      sender: sender.publicKey,
      nonceCounter,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(buildRemainingAccounts(debridgeAccounts))
    .signers([sender])
    .rpc();

  return tx;
}
```

### Message Encoding Examples

```typescript
// Generic message
function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + payload.length);
  result[0] = type;
  result.set(payload, 1);
  return result;
}

// Governance message
function encodeGovernanceMessage(
  proposalId: bigint,
  actions: Array<{target: string; value: bigint; data: Uint8Array}>
): Uint8Array {
  const encoder = new ethers.AbiCoder();

  const encodedActions = actions.map(a => ({
    target: a.target,
    value: a.value,
    data: a.data,
  }));

  const encoded = encoder.encode(
    ['uint256', 'tuple(address,uint256,bytes)[]'],
    [proposalId, encodedActions]
  );

  return ethers.getBytes(encoded);
}

// Oracle update message
function encodeOracleMessage(
  feedId: Uint8Array,
  price: bigint,
  confidence: bigint,
  timestamp: bigint
): Uint8Array {
  const encoder = new ethers.AbiCoder();

  const encoded = encoder.encode(
    ['bytes32', 'int256', 'uint256', 'uint256'],
    [feedId, price, confidence, timestamp]
  );

  return ethers.getBytes(encoded);
}
```

## Use Cases

### 1. Cross-Chain Governance

```typescript
// Send a governance proposal from Solana to Ethereum
const proposal = {
  id: 42n,
  actions: [
    {
      target: '0x1234...', // Treasury contract
      value: 0n,
      data: encodeTransferCall(recipient, amount),
    }
  ],
};

const message = encodeGovernanceMessage(proposal.id, proposal.actions);
await sendMessage(program, authority, CHAIN_IDS.ETHEREUM, governanceContract, message, executionFee);
```

### 2. Cross-Chain Oracle

```typescript
// Push price data from Solana to Ethereum
const priceUpdate = {
  feedId: SOL_USD_FEED_ID,
  price: 10050000000n, // $100.50 with 8 decimals
  confidence: 5000000n,
  timestamp: BigInt(Date.now()),
};

const message = encodeOracleMessage(
  priceUpdate.feedId,
  priceUpdate.price,
  priceUpdate.confidence,
  priceUpdate.timestamp
);

await sendMessage(program, oracleAuthority, CHAIN_IDS.ETHEREUM, oracleContract, message, 0n);
```

### 3. Cross-Chain State Sync

```typescript
// Sync application state between chains
interface StateUpdate {
  stateRoot: Uint8Array;
  blockNumber: bigint;
  signature: Uint8Array;
}

function encodeStateUpdate(update: StateUpdate): Uint8Array {
  return ethers.concat([
    update.stateRoot,
    ethers.toBeArray(update.blockNumber),
    update.signature,
  ]);
}
```

## Message Verification on Destination

### Solidity Receiver (EVM)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICallProxy {
    function submissionChainIdFrom() external view returns (uint256);
    function submissionNativeSender() external view returns (bytes memory);
}

contract CrossChainReceiver {
    address public callProxy;
    bytes32 public authorizedSolanaProgram;

    modifier onlyFromSolana() {
        require(msg.sender == callProxy, "Only call proxy");

        uint256 sourceChain = ICallProxy(callProxy).submissionChainIdFrom();
        require(sourceChain == SOLANA_CHAIN_ID, "Only from Solana");

        bytes memory sender = ICallProxy(callProxy).submissionNativeSender();
        require(
            keccak256(sender) == authorizedSolanaProgram,
            "Unauthorized sender"
        );
        _;
    }

    function receiveMessage(bytes calldata message) external onlyFromSolana {
        // Process verified message
        _processMessage(message);
    }

    function _processMessage(bytes calldata message) internal {
        uint8 messageType = uint8(message[0]);

        if (messageType == 0x01) {
            _handleGovernance(message[1:]);
        } else if (messageType == 0x02) {
            _handleOracleUpdate(message[1:]);
        }
    }
}
```

## Notes

1. **No Token Transfer**: Message passing uses `amount: 0`
2. **Execution Fee**: Still required to incentivize delivery
3. **Message Format**: Define consistent encoding format across chains
4. **Verification**: Always verify source chain and sender on destination
5. **Nonce Tracking**: Track message nonces to prevent replay attacks
