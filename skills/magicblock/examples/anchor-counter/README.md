# Anchor Counter with Ephemeral Rollups

A simple counter demonstrating delegation, execution, and undelegation.

## Setup

```bash
npm install @solana/web3.js @coral-xyz/anchor @magicblock-labs/ephemeral-rollups-sdk
```

## Rust Program

```rust
// programs/counter/src/lib.rs
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{delegate_account, commit_accounts, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegationProgram;

declare_id!("CounterProgram11111111111111111111111111111");

#[ephemeral]
#[program]
pub mod counter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.counter.authority = ctx.accounts.payer.key();
        ctx.accounts.counter.count = 0;
        msg!("Counter initialized");
        Ok(())
    }

    #[delegate]
    pub fn delegate(ctx: Context<DelegateCounter>) -> Result<()> {
        msg!("Counter delegated to ER");
        Ok(())
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        ctx.accounts.counter.count += 1;
        msg!("Count: {}", ctx.accounts.counter.count);
        Ok(())
    }

    pub fn increment_by(ctx: Context<Increment>, amount: u64) -> Result<()> {
        ctx.accounts.counter.count += amount;
        msg!("Count: {}", ctx.accounts.counter.count);
        Ok(())
    }

    #[commit]
    pub fn undelegate(ctx: Context<UndelegateCounter>) -> Result<()> {
        msg!("Counter undelegated");
        Ok(())
    }
}

#[account]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
}

impl Counter {
    pub const SIZE: usize = 8 + 32 + 8; // discriminator + authority + count
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Counter::SIZE,
        seeds = [b"counter", payer.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegateCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Account to be delegated
    #[account(
        mut,
        seeds = [b"counter", payer.key().as_ref()],
        bump,
        del
    )]
    pub counter: AccountInfo<'info>,
    pub delegation_program: Program<'info, DelegationProgram>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"counter", payer.key().as_ref()],
        bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UndelegateCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Account to be undelegated
    #[account(mut)]
    pub counter: AccountInfo<'info>,
    /// CHECK: Magic context
    pub magic_context: AccountInfo<'info>,
    /// CHECK: Magic program
    pub magic_program: AccountInfo<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
}
```

## TypeScript Client

```typescript
// tests/counter.ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Counter } from "../target/types/counter";

// Constants
const SOLANA_RPC = "https://api.devnet.solana.com";
const ER_RPC = "https://devnet.magicblock.app";

async function main() {
  // 1. Setup connections
  const baseConnection = new Connection(SOLANA_RPC, "confirmed");
  const erConnection = new Connection(ER_RPC, "confirmed");

  // 2. Load wallet
  const payer = Keypair.generate(); // Or load from file

  // 3. Create providers
  const baseProvider = new AnchorProvider(
    baseConnection,
    { publicKey: payer.publicKey, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs },
    { commitment: "confirmed" }
  );

  const erProvider = new AnchorProvider(
    erConnection,
    { publicKey: payer.publicKey, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs },
    { commitment: "confirmed", skipPreflight: true }
  );

  // 4. Load programs
  const baseProgram = new Program<Counter>(IDL, PROGRAM_ID, baseProvider);
  const erProgram = new Program<Counter>(IDL, PROGRAM_ID, erProvider);

  // 5. Derive PDA
  const [counterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), payer.publicKey.toBuffer()],
    PROGRAM_ID
  );

  console.log("Counter PDA:", counterPda.toBase58());

  // 6. Initialize on base layer
  console.log("Initializing counter...");
  await baseProgram.methods
    .initialize()
    .accounts({
      payer: payer.publicKey,
      counter: counterPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  // 7. Delegate to ER
  console.log("Delegating to ER...");
  await baseProgram.methods
    .delegate()
    .accounts({
      payer: payer.publicKey,
      counter: counterPda,
    })
    .signers([payer])
    .rpc();

  // Wait for delegation
  await sleep(2000);

  // Verify delegation
  const accountInfo = await baseConnection.getAccountInfo(counterPda);
  const isDelegated = accountInfo?.owner.equals(DELEGATION_PROGRAM_ID);
  console.log("Delegated:", isDelegated);

  // 8. Increment on ER (fast!)
  console.log("Incrementing on ER...");
  for (let i = 0; i < 10; i++) {
    await erProgram.methods
      .increment()
      .accounts({
        payer: payer.publicKey,
        counter: counterPda,
        authority: payer.publicKey,
      })
      .signers([payer])
      .rpc({ skipPreflight: true });
    console.log(`  Increment ${i + 1}/10`);
  }

  // 9. Read from ER
  const counterState = await erProgram.account.counter.fetch(counterPda);
  console.log("Count on ER:", counterState.count.toString());

  // 10. Undelegate
  console.log("Undelegating...");
  await erProgram.methods
    .undelegate()
    .accounts({
      payer: payer.publicKey,
      counter: counterPda,
    })
    .signers([payer])
    .rpc({ skipPreflight: true });

  // Wait for finalization
  await sleep(5000);

  // 11. Verify on base layer
  const finalState = await baseProgram.account.counter.fetch(counterPda);
  console.log("Final count on Solana:", finalState.count.toString());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
```

## Key Points

1. **Initialize on Base Layer** - Account creation happens on Solana
2. **Delegate** - Transfer ownership to delegation program
3. **Execute on ER** - Fast operations with `skipPreflight: true`
4. **Undelegate** - Commits state and returns ownership

## Common Issues

| Issue | Solution |
|-------|----------|
| "Account not delegated" | Wait longer after delegation, verify with `isDelegated()` |
| Transaction timeout on ER | Use `skipPreflight: true` |
| State mismatch | Wait for undelegation to finalize before reading base layer |
