# Basic Cross-Chain Transfer Example

Complete example of sending tokens from Solana to an EVM chain using deBridge.

## Rust Program

### Program Structure

```
basic-transfer/
├── Cargo.toml
├── programs/
│   └── basic-transfer/
│       └── src/
│           └── lib.rs
└── tests/
    └── basic-transfer.ts
```

### Cargo.toml

```toml
[package]
name = "basic-transfer"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
anchor-lang = "0.30"
anchor-spl = "0.30"
debridge-solana-sdk = { git = "ssh://git@github.com/debridge-finance/debridge-solana-sdk.git" }
```

### Program Implementation

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint};
use debridge_solana_sdk::prelude::*;
use debridge_solana_sdk::sending::{SendIx, invoke_debridge_send};

declare_id!("YourProgramId11111111111111111111111111111");

#[program]
pub mod basic_transfer {
    use super::*;

    /// Send tokens to an EVM chain via deBridge
    ///
    /// # Arguments
    /// * `target_chain_id` - 32-byte deBridge chain identifier
    /// * `receiver` - Recipient address on destination (20 bytes for EVM)
    /// * `amount` - Amount in token decimals
    /// * `use_asset_fee` - If true, pay fees in bridged token; false = SOL
    pub fn send_to_evm(
        ctx: Context<SendToEvm>,
        target_chain_id: [u8; 32],
        receiver: Vec<u8>,
        amount: u64,
        use_asset_fee: bool,
    ) -> Result<()> {
        // Validate receiver length for EVM (20 bytes)
        require!(
            receiver.len() == 20,
            ErrorCode::InvalidReceiverLength
        );

        // Invoke deBridge send
        invoke_debridge_send(
            SendIx {
                target_chain_id,
                receiver,
                is_use_asset_fee: use_asset_fee,
                amount,
                submission_params: None,
                referral_code: None,
            },
            ctx.remaining_accounts,
        )?;

        emit!(TokensSent {
            sender: ctx.accounts.sender.key(),
            target_chain: target_chain_id,
            amount,
        });

        Ok(())
    }

    /// Send tokens to Ethereum specifically
    pub fn send_to_ethereum(
        ctx: Context<SendToEvm>,
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        invoke_debridge_send(
            SendIx {
                target_chain_id: chain_ids::ETHEREUM_CHAIN_ID,
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

    /// Send tokens to Polygon
    pub fn send_to_polygon(
        ctx: Context<SendToEvm>,
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        invoke_debridge_send(
            SendIx {
                target_chain_id: chain_ids::POLYGON_CHAIN_ID,
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

    /// Send tokens to Arbitrum
    pub fn send_to_arbitrum(
        ctx: Context<SendToEvm>,
        receiver: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        invoke_debridge_send(
            SendIx {
                target_chain_id: chain_ids::ARBITRUM_CHAIN_ID,
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

    /// Get estimated fees for a transfer
    pub fn get_estimated_fees(
        ctx: Context<GetFees>,
        target_chain_id: [u8; 32],
        amount: u64,
    ) -> Result<u64> {
        let total_with_fees = debridge_sending::add_all_fees(
            amount,
            &target_chain_id,
            ctx.remaining_accounts,
        )?;

        Ok(total_with_fees)
    }

    /// Check if a chain is supported
    pub fn is_chain_supported(
        ctx: Context<CheckChain>,
        target_chain_id: [u8; 32],
    ) -> Result<bool> {
        debridge_sending::is_chain_supported(
            &target_chain_id,
            ctx.remaining_accounts,
        )
    }
}

#[derive(Accounts)]
pub struct SendToEvm<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The token mint being bridged
    pub token_mint: Account<'info, Mint>,

    /// Sender's token account
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = sender,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    // Additional deBridge accounts passed via remaining_accounts
}

#[derive(Accounts)]
pub struct GetFees<'info> {
    pub payer: Signer<'info>,
    // deBridge accounts passed via remaining_accounts
}

#[derive(Accounts)]
pub struct CheckChain<'info> {
    pub payer: Signer<'info>,
    // deBridge accounts passed via remaining_accounts
}

#[event]
pub struct TokensSent {
    pub sender: Pubkey,
    pub target_chain: [u8; 32],
    pub amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Receiver address must be 20 bytes for EVM chains")]
    InvalidReceiverLength,

    #[msg("Target chain is not supported")]
    UnsupportedChain,

    #[msg("Insufficient balance for transfer and fees")]
    InsufficientBalance,
}
```

## TypeScript Client

### Setup

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { ethers } from 'ethers';

// Program IDs
const DEBRIDGE_PROGRAM_ID = new PublicKey('DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh');
const SETTINGS_PROGRAM_ID = new PublicKey('DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft');

// Chain IDs
const CHAIN_IDS = {
  ETHEREUM: evmChainIdToBytes(1n),
  POLYGON: evmChainIdToBytes(137n),
  ARBITRUM: evmChainIdToBytes(42161n),
  BNB: evmChainIdToBytes(56n),
};
```

### Helper Functions

```typescript
function evmChainIdToBytes(chainId: bigint): number[] {
  const result = new Array(32).fill(0);
  const bytes = [];
  let temp = chainId;
  while (temp > 0n) {
    bytes.unshift(Number(temp & 0xffn));
    temp >>= 8n;
  }
  result.splice(32 - bytes.length, bytes.length, ...bytes);
  return result;
}

function evmAddressToBytes(address: string): number[] {
  // Remove 0x prefix and convert to bytes
  const hex = address.replace('0x', '');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

async function deriveDeBridgeAccounts(
  connection: Connection,
  tokenMint: PublicKey,
  sender: PublicKey,
  targetChainId: number[],
) {
  const [bridge] = PublicKey.findProgramAddressSync(
    [Buffer.from('BRIDGE'), tokenMint.toBuffer()],
    DEBRIDGE_PROGRAM_ID
  );

  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('STATE')],
    DEBRIDGE_PROGRAM_ID
  );

  const [chainSupportInfo] = PublicKey.findProgramAddressSync(
    [Buffer.from('CHAIN_SUPPORT_INFO'), Buffer.from(targetChainId)],
    SETTINGS_PROGRAM_ID
  );

  const [nonceStorage] = PublicKey.findProgramAddressSync(
    [Buffer.from('NONCE_STORAGE'), sender.toBuffer()],
    DEBRIDGE_PROGRAM_ID
  );

  // Get staking wallet from bridge account
  const bridgeAccount = await connection.getAccountInfo(bridge);
  // Parse staking wallet from bridge data...

  return {
    bridge,
    state,
    chainSupportInfo,
    nonceStorage,
    debridgeProgram: DEBRIDGE_PROGRAM_ID,
    settingsProgram: SETTINGS_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}
```

### Send Transaction

```typescript
async function sendToEthereum(
  program: Program,
  connection: Connection,
  sender: Keypair,
  tokenMint: PublicKey,
  receiverEvmAddress: string,
  amount: bigint,
): Promise<string> {
  // Convert receiver address
  const receiver = evmAddressToBytes(receiverEvmAddress);

  // Get sender's token account
  const senderTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    sender.publicKey
  );

  // Derive deBridge accounts
  const debridgeAccounts = await deriveDeBridgeAccounts(
    connection,
    tokenMint,
    sender.publicKey,
    CHAIN_IDS.ETHEREUM
  );

  // Build remaining accounts
  const remainingAccounts = [
    { pubkey: debridgeAccounts.bridge, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.state, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.chainSupportInfo, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.settingsProgram, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.debridgeProgram, isSigner: false, isWritable: false },
    { pubkey: debridgeAccounts.nonceStorage, isSigner: false, isWritable: true },
    // Add more accounts as required...
  ];

  // Send transaction
  const tx = await program.methods
    .sendToEvm(
      CHAIN_IDS.ETHEREUM,
      Buffer.from(receiver),
      new BN(amount.toString()),
      false, // use native fee
    )
    .accounts({
      sender: sender.publicKey,
      tokenMint,
      senderTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .signers([sender])
    .rpc();

  console.log('Transaction sent:', tx);
  return tx;
}
```

### Usage Example

```typescript
async function main() {
  // Setup
  const connection = new Connection('https://api.mainnet-beta.solana.com');
  const wallet = Keypair.fromSecretKey(/* your secret key */);
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: 'confirmed' }
  );

  const program = new Program(IDL, PROGRAM_ID, provider);

  // Token mint (e.g., USDC)
  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  // Send 100 USDC to Ethereum
  const tx = await sendToEthereum(
    program,
    connection,
    wallet,
    USDC_MINT,
    '0x742d35Cc6634C0532925a3b844Bc9e7595f5bA14', // Ethereum receiver
    100_000_000n, // 100 USDC (6 decimals)
  );

  console.log('Tokens sent! TX:', tx);
}

main().catch(console.error);
```

## Testing

### Anchor Test

```typescript
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { BasicTransfer } from '../target/types/basic_transfer';
import { expect } from 'chai';

describe('basic-transfer', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BasicTransfer as Program<BasicTransfer>;

  it('Checks chain support', async () => {
    const ETHEREUM_CHAIN_ID = Array(32).fill(0);
    ETHEREUM_CHAIN_ID[31] = 1;

    const isSupported = await program.methods
      .isChainSupported(ETHEREUM_CHAIN_ID)
      .accounts({
        payer: provider.wallet.publicKey,
      })
      .remainingAccounts([
        // Add chain support info account
      ])
      .view();

    expect(isSupported).to.be.true;
  });

  it('Gets estimated fees', async () => {
    const ETHEREUM_CHAIN_ID = Array(32).fill(0);
    ETHEREUM_CHAIN_ID[31] = 1;

    const fees = await program.methods
      .getEstimatedFees(
        ETHEREUM_CHAIN_ID,
        new anchor.BN(1_000_000_000) // 1 token
      )
      .accounts({
        payer: provider.wallet.publicKey,
      })
      .remainingAccounts([
        // Add required accounts
      ])
      .view();

    console.log('Estimated fees:', fees.toString());
    expect(fees.toNumber()).to.be.greaterThan(0);
  });
});
```

## Notes

1. **Account Order**: deBridge requires accounts in a specific order. See `resources/program-ids.md` for the full list.

2. **Fees**: Always estimate fees before sending to ensure sufficient balance.

3. **EVM Addresses**: EVM addresses are 20 bytes. Remove the `0x` prefix when converting.

4. **Mainnet Only**: deBridge infrastructure is on mainnet. Use mainnet fork for testing.
