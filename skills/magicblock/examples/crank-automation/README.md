# Crank Automation with MagicBlock

Schedule automatic, recurring on-chain operations using MagicBlock's crank system.

## Overview

Cranks enable:
- **Scheduled Execution** - Run functions at fixed intervals
- **Automated Game Loops** - Update game state periodically
- **Timed Events** - Trigger actions based on time
- **Gasless Automation** - No manual transactions needed

## Use Cases

- Game tick/update loops
- Auction countdowns
- Interest accrual
- Leaderboard updates
- NPC behavior
- Resource generation

## Setup

```toml
[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }
```

## Rust Program

```rust
// programs/crank_game/src/lib.rs
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use ephemeral_rollups_sdk::cpi::{schedule_crank, cancel_crank, MAGIC_PROGRAM_ID};

declare_id!("CrankGameProgram11111111111111111111111111");

#[ephemeral]
#[program]
pub mod crank_game {
    use super::*;

    /// Initialize game with automatic updates
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.authority = ctx.accounts.payer.key();
        game.tick = 0;
        game.resources = 0;
        game.last_update = Clock::get()?.unix_timestamp;
        game.crank_active = false;
        Ok(())
    }

    /// Start the automatic game loop
    pub fn start_crank(ctx: Context<StartCrank>, interval_ms: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(!game.crank_active, GameError::CrankAlreadyActive);

        // Schedule the crank
        schedule_crank(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.game.to_account_info(),
            &ctx.accounts.magic_program,
            "game_loop", // Function to call
            interval_ms, // Interval in milliseconds
        )?;

        game.crank_active = true;
        msg!("Crank started: {} ms interval", interval_ms);
        Ok(())
    }

    /// Stop the automatic game loop
    pub fn stop_crank(ctx: Context<StopCrank>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.crank_active, GameError::CrankNotActive);

        cancel_crank(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.game.to_account_info(),
            &ctx.accounts.magic_program,
        )?;

        game.crank_active = false;
        msg!("Crank stopped");
        Ok(())
    }

    /// Called automatically by the crank system
    pub fn game_loop(ctx: Context<GameLoop>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let now = Clock::get()?.unix_timestamp;

        // Update game state
        game.tick += 1;

        // Generate resources based on time elapsed
        let time_elapsed = now - game.last_update;
        game.resources += (time_elapsed as u64) * 10; // 10 resources per second

        game.last_update = now;

        msg!("Game loop tick: {}, resources: {}", game.tick, game.resources);
        Ok(())
    }

    /// Manual update (can also be called manually)
    pub fn manual_update(ctx: Context<ManualUpdate>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let now = Clock::get()?.unix_timestamp;

        let time_elapsed = now - game.last_update;
        game.resources += (time_elapsed as u64) * 10;
        game.last_update = now;

        msg!("Manual update: resources = {}", game.resources);
        Ok(())
    }
}

#[account]
pub struct GameState {
    pub authority: Pubkey,
    pub tick: u64,
    pub resources: u64,
    pub last_update: i64,
    pub crank_active: bool,
}

impl GameState {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = GameState::SIZE,
        seeds = [b"game", payer.key().as_ref()],
        bump
    )]
    pub game: Account<'info, GameState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = authority @ GameError::Unauthorized)]
    pub game: Account<'info, GameState>,
    pub authority: Signer<'info>,
    /// CHECK: Magic program for crank
    pub magic_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct StopCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = authority @ GameError::Unauthorized)]
    pub game: Account<'info, GameState>,
    pub authority: Signer<'info>,
    /// CHECK: Magic program
    pub magic_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct GameLoop<'info> {
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct ManualUpdate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[error_code]
pub enum GameError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Crank is already active")]
    CrankAlreadyActive,
    #[msg("Crank is not active")]
    CrankNotActive,
}
```

## TypeScript Client

```typescript
// crank-client.ts
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { CrankGame } from "../target/types/crank_game";

const ER_RPC = "https://devnet.magicblock.app";

class CrankManager {
  private connection: Connection;
  private program: Program<CrankGame>;
  private payer: Keypair;

  constructor(payer: Keypair) {
    this.payer = payer;
    this.connection = new Connection(ER_RPC, "confirmed");

    const provider = new AnchorProvider(
      this.connection,
      new Wallet(payer),
      { commitment: "confirmed", skipPreflight: true }
    );

    this.program = new Program<CrankGame>(IDL, PROGRAM_ID, provider);
  }

  async initialize(): Promise<PublicKey> {
    const [gamePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), this.payer.publicKey.toBuffer()],
      this.program.programId
    );

    await this.program.methods
      .initialize()
      .accounts({
        payer: this.payer.publicKey,
        game: gamePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.payer])
      .rpc({ skipPreflight: true });

    console.log("Game initialized:", gamePda.toBase58());
    return gamePda;
  }

  async startCrank(gamePda: PublicKey, intervalMs: number): Promise<void> {
    await this.program.methods
      .startCrank(new BN(intervalMs))
      .accounts({
        payer: this.payer.publicKey,
        game: gamePda,
        authority: this.payer.publicKey,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .signers([this.payer])
      .rpc({ skipPreflight: true });

    console.log(`Crank started: ${intervalMs}ms interval`);
  }

  async stopCrank(gamePda: PublicKey): Promise<void> {
    await this.program.methods
      .stopCrank()
      .accounts({
        payer: this.payer.publicKey,
        game: gamePda,
        authority: this.payer.publicKey,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .signers([this.payer])
      .rpc({ skipPreflight: true });

    console.log("Crank stopped");
  }

  async getState(gamePda: PublicKey): Promise<any> {
    return await this.program.account.gameState.fetch(gamePda);
  }

  subscribeToUpdates(gamePda: PublicKey, callback: (state: any) => void): number {
    return this.connection.onAccountChange(gamePda, (accountInfo) => {
      const decoded = this.program.coder.accounts.decode(
        "GameState",
        accountInfo.data
      );
      callback(decoded);
    });
  }
}

// Example Usage
async function main() {
  const payer = Keypair.generate();
  const manager = new CrankManager(payer);

  // Initialize game
  const gamePda = await manager.initialize();

  // Subscribe to updates
  manager.subscribeToUpdates(gamePda, (state) => {
    console.log(`Tick: ${state.tick}, Resources: ${state.resources}`);
  });

  // Start crank (every 100ms = 10 updates per second)
  await manager.startCrank(gamePda, 100);

  // Let it run for 5 seconds
  await new Promise((r) => setTimeout(r, 5000));

  // Check state
  const state = await manager.getState(gamePda);
  console.log("Final state:", state);

  // Stop crank
  await manager.stopCrank(gamePda);
}

main().catch(console.error);
```

## Crank Intervals

| Interval | Updates/Second | Use Case |
|----------|---------------|----------|
| 10ms | 100 | Real-time action games |
| 50ms | 20 | Fast-paced games |
| 100ms | 10 | Standard game loops |
| 500ms | 2 | Turn-based updates |
| 1000ms | 1 | Slow state changes |

## Best Practices

1. **Idempotent Operations** - Game loop should handle being called multiple times safely
2. **Time-Based Logic** - Use timestamps, not tick counts, for deterministic behavior
3. **State Validation** - Check crank_active before operations
4. **Resource Limits** - Be mindful of compute units per crank call
5. **Graceful Shutdown** - Always stop cranks before undelegating

## Patterns

### Time-Based Resource Generation

```rust
let elapsed = now - last_update;
let new_resources = (elapsed as u64) * generation_rate;
game.resources = game.resources.saturating_add(new_resources);
```

### Countdown Timer

```rust
if game.end_time > 0 && now >= game.end_time {
    game.status = GameStatus::Ended;
    // Stop crank automatically
}
```

### Rate-Limited Actions

```rust
if now - last_action >= cooldown_seconds {
    // Perform action
    game.last_action = now;
}
```
