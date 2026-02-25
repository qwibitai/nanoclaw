// MagicBlock Ephemeral Rollups TypeScript Client Template
// Copy this file to your project's tests or client directory

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  createDelegateInstruction,
  createUndelegateInstruction,
  GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // RPC Endpoints
  SOLANA_RPC: "https://api.devnet.solana.com",
  ER_RPC: "https://devnet-router.magicblock.app",

  // Timeouts
  DELEGATION_TIMEOUT: 10000,
  FINALIZATION_TIMEOUT: 15000,

  // Your Program ID
  PROGRAM_ID: new PublicKey("YourProgramId111111111111111111111111111111"),
};

// =============================================================================
// TYPES
// =============================================================================

// Import your IDL and types
// import { MyProgram } from "../target/types/my_program";
// import IDL from "../target/idl/my_program.json";

interface State {
  authority: PublicKey;
  value: BN;
  bump: number;
}

// =============================================================================
// CLIENT CLASS
// =============================================================================

export class MagicBlockClient {
  private baseConnection: Connection;
  private erConnection: Connection;
  private baseProvider: AnchorProvider;
  private erProvider: AnchorProvider;
  private baseProgram: Program;
  private erProgram: Program;
  private wallet: Keypair;

  constructor(wallet: Keypair, idl: any) {
    this.wallet = wallet;

    // Setup connections
    this.baseConnection = new Connection(CONFIG.SOLANA_RPC, "confirmed");
    this.erConnection = new Connection(CONFIG.ER_RPC, "confirmed");

    // Setup providers
    const walletAdapter = new Wallet(wallet);

    this.baseProvider = new AnchorProvider(this.baseConnection, walletAdapter, {
      commitment: "confirmed",
    });

    this.erProvider = new AnchorProvider(this.erConnection, walletAdapter, {
      commitment: "confirmed",
      skipPreflight: true, // Required for ER
    });

    // Setup programs
    this.baseProgram = new Program(idl, CONFIG.PROGRAM_ID, this.baseProvider);
    this.erProgram = new Program(idl, CONFIG.PROGRAM_ID, this.erProvider);
  }

  // ===========================================================================
  // DELEGATION UTILITIES
  // ===========================================================================

  /**
   * Check if an account is delegated to ER
   */
  async isDelegated(accountPubkey: PublicKey): Promise<boolean> {
    const accountInfo = await this.baseConnection.getAccountInfo(accountPubkey);
    if (!accountInfo) return false;
    return accountInfo.owner.equals(DELEGATION_PROGRAM_ID);
  }

  /**
   * Wait for delegation to complete
   */
  async waitForDelegation(
    accountPubkey: PublicKey,
    timeout: number = CONFIG.DELEGATION_TIMEOUT
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.isDelegated(accountPubkey)) {
        return true;
      }
      await this.sleep(1000);
    }

    return false;
  }

  /**
   * Wait for undelegation to complete
   */
  async waitForUndelegation(
    accountPubkey: PublicKey,
    timeout: number = CONFIG.FINALIZATION_TIMEOUT
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (!(await this.isDelegated(accountPubkey))) {
        return true;
      }
      await this.sleep(1000);
    }

    return false;
  }

  // ===========================================================================
  // BASE LAYER OPERATIONS
  // ===========================================================================

  /**
   * Derive PDA for user's state account
   */
  deriveStatePda(userPubkey: PublicKey = this.wallet.publicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("state"), userPubkey.toBuffer()],
      CONFIG.PROGRAM_ID
    );
  }

  /**
   * Initialize state on base layer
   */
  async initialize(): Promise<{ signature: string; statePda: PublicKey }> {
    const [statePda] = this.deriveStatePda();

    console.log("Initializing state on base layer...");

    const signature = await this.baseProgram.methods
      .initialize()
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    console.log("✓ Initialized:", signature);
    return { signature, statePda };
  }

  /**
   * Delegate account to ER
   */
  async delegate(statePda: PublicKey): Promise<string> {
    // Check if already delegated
    if (await this.isDelegated(statePda)) {
      console.log("Account already delegated");
      return "";
    }

    console.log("Delegating to ER...");

    const signature = await this.baseProgram.methods
      .delegate()
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
      })
      .signers([this.wallet])
      .rpc();

    console.log("✓ Delegation tx:", signature);

    // Wait for delegation
    const delegated = await this.waitForDelegation(statePda);
    if (!delegated) {
      throw new Error("Delegation timeout");
    }

    console.log("✓ Account delegated");
    return signature;
  }

  // ===========================================================================
  // EPHEMERAL ROLLUP OPERATIONS
  // ===========================================================================

  /**
   * Execute increment on ER
   */
  async increment(statePda: PublicKey): Promise<string> {
    console.log("Incrementing on ER...");

    const signature = await this.erProgram.methods
      .increment()
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
        authority: this.wallet.publicKey,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    console.log("✓ Incremented:", signature);
    return signature;
  }

  /**
   * Set value on ER
   */
  async setValue(statePda: PublicKey, value: number): Promise<string> {
    console.log(`Setting value to ${value} on ER...`);

    const signature = await this.erProgram.methods
      .setValue(new BN(value))
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
        authority: this.wallet.publicKey,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    console.log("✓ Value set:", signature);
    return signature;
  }

  /**
   * Commit state without undelegating
   */
  async commit(statePda: PublicKey): Promise<string> {
    console.log("Committing state...");

    const signature = await this.erProgram.methods
      .commit()
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    // Verify commitment
    const commitSig = await GetCommitmentSignature(this.erConnection, statePda);
    console.log("✓ Committed:", commitSig);

    return signature;
  }

  /**
   * Undelegate and finalize
   */
  async undelegate(statePda: PublicKey): Promise<string> {
    console.log("Undelegating...");

    const signature = await this.erProgram.methods
      .undelegate()
      .accounts({
        payer: this.wallet.publicKey,
        state: statePda,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    console.log("✓ Undelegation tx:", signature);

    // Wait for finalization
    const undelegated = await this.waitForUndelegation(statePda);
    if (!undelegated) {
      throw new Error("Undelegation timeout");
    }

    console.log("✓ Account finalized");
    return signature;
  }

  // ===========================================================================
  // STATE QUERIES
  // ===========================================================================

  /**
   * Fetch state from base layer
   */
  async fetchStateFromBase(statePda: PublicKey): Promise<State> {
    return await this.baseProgram.account.state.fetch(statePda);
  }

  /**
   * Fetch state from ER
   */
  async fetchStateFromER(statePda: PublicKey): Promise<State> {
    return await this.erProgram.account.state.fetch(statePda);
  }

  /**
   * Subscribe to state changes on ER
   */
  subscribeToState(
    statePda: PublicKey,
    callback: (state: State) => void
  ): number {
    return this.erConnection.onAccountChange(statePda, (accountInfo) => {
      try {
        const decoded = this.erProgram.coder.accounts.decode(
          "State",
          accountInfo.data
        );
        callback(decoded);
      } catch (e) {
        console.error("Failed to decode:", e);
      }
    });
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get wallet public key
   */
  get publicKey(): PublicKey {
    return this.wallet.publicKey;
  }
}

// =============================================================================
// USAGE EXAMPLE
// =============================================================================

async function main() {
  // Load or generate wallet
  const wallet = Keypair.generate();

  // Create client
  // const client = new MagicBlockClient(wallet, IDL);

  // Initialize
  // const { statePda } = await client.initialize();

  // Delegate
  // await client.delegate(statePda);

  // Execute operations on ER
  // await client.increment(statePda);
  // await client.setValue(statePda, 100);

  // Subscribe to updates
  // client.subscribeToState(statePda, (state) => {
  //   console.log("State updated:", state.value.toString());
  // });

  // Undelegate when done
  // await client.undelegate(statePda);

  // Verify final state
  // const finalState = await client.fetchStateFromBase(statePda);
  // console.log("Final value:", finalState.value.toString());
}

// main().catch(console.error);

export default MagicBlockClient;
