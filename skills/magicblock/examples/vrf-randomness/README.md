# VRF Randomness with MagicBlock

Integrate verifiable random functions for on-chain randomness in games and applications.

## Overview

MagicBlock VRF provides cryptographically secure, verifiable randomness:
- **Unpredictable** - Cannot be known before request
- **Verifiable** - Anyone can verify the randomness is valid
- **On-chain** - Results delivered via callback

## Setup

```toml
# Cargo.toml
[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }
ephemeral-vrf-sdk = { version = "0.3", features = ["anchor"] }
```

## Rust Program

```rust
// programs/vrf_game/src/lib.rs
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use ephemeral_vrf_sdk::anchor::{vrf, VrfResult};
use ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE;

declare_id!("VrfGameProgram11111111111111111111111111111");

#[vrf]
#[ephemeral]
#[program]
pub mod vrf_game {
    use super::*;

    /// Initialize game state
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.authority = ctx.accounts.payer.key();
        game.last_roll = 0;
        game.total_rolls = 0;
        game.pending_request = false;
        Ok(())
    }

    /// Request a dice roll (VRF request)
    pub fn roll_dice(ctx: Context<RollDice>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(!game.pending_request, GameError::RequestPending);

        game.pending_request = true;
        msg!("Dice roll requested");
        Ok(())
    }

    /// Callback receives VRF result
    /// NOTE: Function name must match the request pattern: <request_fn>_callback
    pub fn roll_dice_callback(ctx: Context<DiceCallback>, result: VrfResult) -> Result<()> {
        let game = &mut ctx.accounts.game;

        // Extract randomness (32 bytes)
        let randomness = result.randomness;

        // Convert first 8 bytes to u64 for dice roll (1-6)
        let random_value = u64::from_le_bytes(
            randomness[0..8].try_into().unwrap()
        );
        let dice_roll = (random_value % 6) + 1;

        game.last_roll = dice_roll;
        game.total_rolls += 1;
        game.pending_request = false;

        msg!("Dice rolled: {}", dice_roll);
        Ok(())
    }

    /// Request random number in range [min, max]
    pub fn random_in_range(ctx: Context<RandomInRange>, min: u64, max: u64) -> Result<()> {
        require!(max > min, GameError::InvalidRange);
        let game = &mut ctx.accounts.game;
        game.pending_min = min;
        game.pending_max = max;
        game.pending_request = true;
        Ok(())
    }

    pub fn random_in_range_callback(ctx: Context<RandomCallback>, result: VrfResult) -> Result<()> {
        let game = &mut ctx.accounts.game;

        let randomness = result.randomness;
        let random_value = u64::from_le_bytes(randomness[0..8].try_into().unwrap());

        // Map to range [min, max]
        let range = game.pending_max - game.pending_min + 1;
        let result_value = game.pending_min + (random_value % range);

        game.last_roll = result_value;
        game.total_rolls += 1;
        game.pending_request = false;

        msg!("Random result: {} (range {}-{})", result_value, game.pending_min, game.pending_max);
        Ok(())
    }
}

#[account]
pub struct GameState {
    pub authority: Pubkey,
    pub last_roll: u64,
    pub total_rolls: u64,
    pub pending_request: bool,
    pub pending_min: u64,
    pub pending_max: u64,
}

impl GameState {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 1 + 8 + 8;
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
pub struct RollDice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"game", payer.key().as_ref()], bump)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct DiceCallback<'info> {
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct RandomInRange<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct RandomCallback<'info> {
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[error_code]
pub enum GameError {
    #[msg("A random request is already pending")]
    RequestPending,
    #[msg("Invalid range: max must be greater than min")]
    InvalidRange,
}
```

## TypeScript Client

```typescript
// vrf-client.ts
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { VrfGame } from "../target/types/vrf_game";

const ER_RPC = "https://devnet.magicblock.app";

async function rollDice(
  program: Program<VrfGame>,
  payer: Keypair,
  gamePda: PublicKey
) {
  console.log("Requesting dice roll...");

  // Send VRF request
  const sig = await program.methods
    .rollDice()
    .accounts({
      payer: payer.publicKey,
      game: gamePda,
    })
    .signers([payer])
    .rpc({ skipPreflight: true });

  console.log("Request sent:", sig);

  // Wait for callback
  console.log("Waiting for VRF callback...");
  await waitForResult(program, gamePda);

  // Read result
  const gameState = await program.account.gameState.fetch(gamePda);
  console.log("Dice result:", gameState.lastRoll.toString());

  return gameState.lastRoll;
}

async function waitForResult(
  program: Program<VrfGame>,
  gamePda: PublicKey,
  timeout: number = 30000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const state = await program.account.gameState.fetch(gamePda);
    if (!state.pendingRequest) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("VRF callback timeout");
}

// Subscribe to real-time updates
function subscribeToRolls(
  connection: Connection,
  program: Program<VrfGame>,
  gamePda: PublicKey,
  onRoll: (roll: number) => void
) {
  let lastRoll = 0;

  return connection.onAccountChange(gamePda, (accountInfo) => {
    const decoded = program.coder.accounts.decode("GameState", accountInfo.data);
    if (decoded.lastRoll.toNumber() !== lastRoll) {
      lastRoll = decoded.lastRoll.toNumber();
      onRoll(lastRoll);
    }
  });
}

// Main
async function main() {
  const connection = new Connection(ER_RPC, "confirmed");
  const payer = Keypair.generate();

  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: true,
  });

  const program = new Program<VrfGame>(IDL, PROGRAM_ID, provider);

  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), payer.publicKey.toBuffer()],
    program.programId
  );

  // Initialize
  await program.methods
    .initialize()
    .accounts({
      payer: payer.publicKey,
      game: gamePda,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  // Subscribe to updates
  subscribeToRolls(connection, program, gamePda, (roll) => {
    console.log("New roll:", roll);
  });

  // Roll dice
  const result = await rollDice(program, payer, gamePda);
  console.log("Final result:", result);
}

main().catch(console.error);
```

## VRF Patterns

### 1. Simple Random Number

```rust
let random_u64 = u64::from_le_bytes(result.randomness[0..8].try_into().unwrap());
```

### 2. Random in Range [min, max]

```rust
let range = max - min + 1;
let result = min + (random_u64 % range);
```

### 3. Random Boolean (coin flip)

```rust
let is_heads = result.randomness[0] % 2 == 0;
```

### 4. Random Selection from Array

```rust
let options = ["fire", "water", "earth", "air"];
let index = (random_u64 as usize) % options.len();
let selected = options[index];
```

### 5. Weighted Random

```rust
let weights = [50, 30, 15, 5]; // Must sum to 100
let total: u64 = weights.iter().sum();
let roll = random_u64 % total;

let mut cumulative = 0;
let mut selected = 0;
for (i, weight) in weights.iter().enumerate() {
    cumulative += weight;
    if roll < cumulative {
        selected = i;
        break;
    }
}
```

### 6. Multiple Random Values

```rust
// Use different portions of the 32-byte randomness
let random1 = u64::from_le_bytes(result.randomness[0..8].try_into().unwrap());
let random2 = u64::from_le_bytes(result.randomness[8..16].try_into().unwrap());
let random3 = u64::from_le_bytes(result.randomness[16..24].try_into().unwrap());
let random4 = u64::from_le_bytes(result.randomness[24..32].try_into().unwrap());
```

## Important Notes

1. **Callback Naming**: The callback function must be named `<request_fn>_callback`
2. **Account in Callback**: The game account must be included in callback accounts
3. **Pending State**: Track pending requests to prevent duplicate requests
4. **Timeout Handling**: VRF callbacks typically arrive within seconds
