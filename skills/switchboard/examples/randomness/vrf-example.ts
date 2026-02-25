/**
 * Switchboard VRF Randomness Example
 *
 * This example demonstrates how to integrate Switchboard's
 * Verifiable Random Function (VRF) for on-chain randomness.
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  network: (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet",

  rpcEndpoint: process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",

  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  // Queue addresses for randomness
  queues: {
    mainnet: new web3.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"),
    devnet: new web3.PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"),
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function loadWallet(path: string): web3.Keypair {
  const resolvedPath = path.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function getProgramId(network: "mainnet" | "devnet"): web3.PublicKey {
  return network === "mainnet" ? ON_DEMAND_MAINNET_PID : ON_DEMAND_DEVNET_PID;
}

function getQueue(network: "mainnet" | "devnet"): web3.PublicKey {
  return CONFIG.queues[network];
}

/**
 * Convert random bytes to various formats
 */
function randomBytesToNumber(bytes: Uint8Array, max: number): number {
  // Use first 6 bytes for a large random number, then mod by max
  const value =
    bytes[0] +
    bytes[1] * 256 +
    bytes[2] * 65536 +
    bytes[3] * 16777216 +
    bytes[4] * 4294967296 +
    bytes[5] * 1099511627776;
  return value % max;
}

function randomBytesToBool(bytes: Uint8Array): boolean {
  return bytes[0] % 2 === 0;
}

// ============================================================================
// VRF RANDOMNESS PATTERNS
// ============================================================================

/**
 * Example: Coin Flip Game
 *
 * This demonstrates the pattern for a simple coin flip using VRF.
 * In a real implementation, you would:
 * 1. Request randomness from Switchboard
 * 2. Wait for oracle fulfillment
 * 3. Reveal and use the random value
 */
function demonstrateCoinFlip(randomBytes: Uint8Array): string {
  const isHeads = randomBytesToBool(randomBytes);
  return isHeads ? "Heads" : "Tails";
}

/**
 * Example: Dice Roll
 */
function demonstrateDiceRoll(randomBytes: Uint8Array, sides: number = 6): number {
  return randomBytesToNumber(randomBytes, sides) + 1;
}

/**
 * Example: Random Selection from Array
 */
function randomSelect<T>(randomBytes: Uint8Array, items: T[]): T {
  const index = randomBytesToNumber(randomBytes, items.length);
  return items[index];
}

/**
 * Example: Shuffle Array (Fisher-Yates)
 */
function shuffleArray<T>(randomBytes: Uint8Array, items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomBytesToNumber(randomBytes.slice(i * 4), i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ============================================================================
// RUST INTEGRATION EXAMPLE
// ============================================================================

const RUST_EXAMPLE = `
// Rust/Anchor program for VRF randomness

use anchor_lang::prelude::*;
use switchboard_on_demand::RandomnessAccountData;

declare_id!("YourProgramId111111111111111111111111111111");

#[program]
pub mod vrf_example {
    use super::*;

    /// Coin flip using Switchboard randomness
    pub fn coin_flip(ctx: Context<CoinFlip>) -> Result<()> {
        // Parse randomness account
        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account.to_account_info()
        )?;

        // Get verified random value
        let random_value = randomness_data.get_value(
            &ctx.accounts.clock
        )?;

        // Use first byte for coin flip
        let is_heads = random_value[0] % 2 == 0;

        msg!("Coin flip result: {}", if is_heads { "Heads" } else { "Tails" });

        // Store result in game state
        ctx.accounts.game_state.result = is_heads;
        ctx.accounts.game_state.revealed = true;

        Ok(())
    }

    /// Roll a dice with specified number of sides
    pub fn roll_dice(ctx: Context<RollDice>, sides: u8) -> Result<()> {
        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account.to_account_info()
        )?;

        let random_value = randomness_data.get_value(&ctx.accounts.clock)?;

        // Use first byte, mod by sides, add 1 (1-indexed)
        let roll = (random_value[0] % sides) + 1;

        msg!("Dice roll (d{}): {}", sides, roll);

        ctx.accounts.game_state.last_roll = roll;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CoinFlip<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Randomness account from Switchboard
    pub randomness_account: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct RollDice<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Randomness account from Switchboard
    pub randomness_account: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[account]
pub struct GameState {
    pub authority: Pubkey,
    pub result: bool,
    pub revealed: bool,
    pub last_roll: u8,
}
`;

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard VRF Randomness Example");
  console.log("=".repeat(60));

  // Setup
  const wallet = loadWallet(CONFIG.walletPath);
  console.log("\nWallet:", wallet.publicKey.toBase58());

  const connection = new web3.Connection(CONFIG.rpcEndpoint, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {});

  // Load Switchboard program
  const programId = getProgramId(CONFIG.network);
  const sbProgram = await Program.at(programId, provider);
  console.log("Program:", programId.toBase58());

  // Get queue
  const queueKey = getQueue(CONFIG.network);
  console.log("Queue:", queueKey.toBase58());

  // Demonstrate randomness patterns with mock data
  console.log("\n--- Randomness Demonstration ---");
  console.log("(Using simulated random bytes for demonstration)");

  // Generate mock random bytes (in real usage, these come from Switchboard)
  const mockRandomBytes = new Uint8Array(32);
  crypto.getRandomValues(mockRandomBytes);

  console.log("\nRandom bytes (hex):", Buffer.from(mockRandomBytes).toString("hex").slice(0, 32) + "...");

  // Coin flip
  console.log("\n1. Coin Flip:");
  for (let i = 0; i < 5; i++) {
    const bytes = new Uint8Array([mockRandomBytes[i], ...mockRandomBytes.slice(1)]);
    console.log(`   Flip ${i + 1}: ${demonstrateCoinFlip(bytes)}`);
  }

  // Dice rolls
  console.log("\n2. Dice Rolls:");
  console.log(`   D6: ${demonstrateDiceRoll(mockRandomBytes, 6)}`);
  console.log(`   D20: ${demonstrateDiceRoll(mockRandomBytes, 20)}`);
  console.log(`   D100: ${demonstrateDiceRoll(mockRandomBytes, 100)}`);

  // Random selection
  console.log("\n3. Random Selection:");
  const items = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];
  console.log(`   Items: ${items.join(", ")}`);
  console.log(`   Selected: ${randomSelect(mockRandomBytes, items)}`);

  // Shuffle
  console.log("\n4. Array Shuffle:");
  const cards = ["A", "K", "Q", "J", "10"];
  console.log(`   Original: ${cards.join(", ")}`);
  console.log(`   Shuffled: ${shuffleArray(mockRandomBytes, cards).join(", ")}`);

  // Integration pattern
  console.log("\n" + "=".repeat(60));
  console.log("VRF Integration Pattern");
  console.log("=".repeat(60));

  console.log(`
Switchboard VRF provides cryptographically secure randomness
that can be verified on-chain. The typical flow is:

1. REQUEST: Your program requests randomness from Switchboard
2. FULFILL: Switchboard oracles generate and submit random value
3. REVEAL: Your program reads and uses the verified random value

Key features:
- Verifiable: Anyone can verify the randomness is legitimate
- Tamper-proof: Neither user nor oracle can predict/manipulate
- On-chain: All verification happens on Solana

Use cases:
- Gaming (dice rolls, card shuffles, loot drops)
- NFT minting (random trait assignment)
- Lotteries and raffles
- Fair selection mechanisms
`);

  console.log("\n--- Rust Integration Example ---");
  console.log(RUST_EXAMPLE);

  console.log("=".repeat(60));
  console.log("See examples at: github.com/switchboard-xyz/sb-on-demand-examples/tree/main/solana/randomness");
  console.log("=".repeat(60));
}

main().catch(console.error);
