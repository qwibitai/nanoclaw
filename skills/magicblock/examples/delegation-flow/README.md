# Complete Delegation Flow

Full example showing the delegation lifecycle with proper error handling and state management.

## Overview

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Initialize │───▶│  Delegate   │───▶│   Execute   │───▶│ Undelegate  │
│ (Base Layer)│    │ (Base Layer)│    │    (ER)     │    │    (ER)     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

## TypeScript Implementation

```typescript
// delegation-flow.ts
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// Configuration
const CONFIG = {
  SOLANA_RPC: "https://api.devnet.solana.com",
  ER_RPC: "https://devnet-router.magicblock.app",
  DELEGATION_TIMEOUT: 10000, // 10 seconds
  FINALIZATION_TIMEOUT: 15000, // 15 seconds
};

class DelegationManager {
  private baseConnection: Connection;
  private erConnection: Connection;
  private baseProvider: AnchorProvider;
  private erProvider: AnchorProvider;
  private baseProgram: Program;
  private erProgram: Program;
  private wallet: Keypair;

  constructor(wallet: Keypair, programId: PublicKey, idl: any) {
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
      skipPreflight: true,
    });

    // Setup programs
    this.baseProgram = new Program(idl, programId, this.baseProvider);
    this.erProgram = new Program(idl, programId, this.erProvider);
  }

  /**
   * Check if account is delegated
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

  /**
   * Initialize account on base layer
   */
  async initialize(accountPda: PublicKey): Promise<string> {
    console.log("Initializing account on base layer...");

    const sig = await this.baseProgram.methods
      .initialize()
      .accounts({
        payer: this.wallet.publicKey,
        account: accountPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    console.log("✓ Initialized:", sig);
    return sig;
  }

  /**
   * Delegate account to ER
   */
  async delegate(accountPda: PublicKey): Promise<string> {
    // Check if already delegated
    if (await this.isDelegated(accountPda)) {
      console.log("Account already delegated");
      return "";
    }

    console.log("Delegating to ER...");

    const sig = await this.baseProgram.methods
      .delegate()
      .accounts({
        payer: this.wallet.publicKey,
        account: accountPda,
      })
      .signers([this.wallet])
      .rpc();

    console.log("✓ Delegation tx sent:", sig);

    // Wait for delegation
    const delegated = await this.waitForDelegation(accountPda);
    if (!delegated) {
      throw new Error("Delegation timeout - account not delegated");
    }

    console.log("✓ Account delegated");
    return sig;
  }

  /**
   * Execute operation on ER
   */
  async executeOnER(
    accountPda: PublicKey,
    method: string,
    args: any[] = []
  ): Promise<string> {
    // Verify account is delegated
    if (!(await this.isDelegated(accountPda))) {
      throw new Error("Account not delegated - cannot execute on ER");
    }

    console.log(`Executing ${method} on ER...`);

    const sig = await (this.erProgram.methods as any)
      [method](...args)
      .accounts({
        payer: this.wallet.publicKey,
        account: accountPda,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    console.log(`✓ ${method} executed:`, sig);
    return sig;
  }

  /**
   * Commit state without undelegating
   */
  async commit(accountPda: PublicKey): Promise<string> {
    console.log("Committing state to base layer...");

    const sig = await this.erProgram.methods
      .commit()
      .accounts({
        payer: this.wallet.publicKey,
        account: accountPda,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    // Verify commitment
    const commitSig = await GetCommitmentSignature(this.erConnection, accountPda);
    console.log("✓ Committed:", commitSig);

    return sig;
  }

  /**
   * Undelegate and return ownership
   */
  async undelegate(accountPda: PublicKey): Promise<string> {
    console.log("Undelegating from ER...");

    const sig = await this.erProgram.methods
      .undelegate()
      .accounts({
        payer: this.wallet.publicKey,
        account: accountPda,
      })
      .signers([this.wallet])
      .rpc({ skipPreflight: true });

    console.log("✓ Undelegation tx sent:", sig);

    // Wait for finalization
    const undelegated = await this.waitForUndelegation(accountPda);
    if (!undelegated) {
      throw new Error("Undelegation timeout - account still delegated");
    }

    console.log("✓ Account undelegated and finalized");
    return sig;
  }

  /**
   * Full flow: delegate -> execute -> undelegate
   */
  async executeWithDelegation(
    accountPda: PublicKey,
    operations: Array<{ method: string; args?: any[] }>
  ): Promise<void> {
    // Delegate
    await this.delegate(accountPda);

    // Execute all operations
    for (const op of operations) {
      await this.executeOnER(accountPda, op.method, op.args || []);
    }

    // Undelegate
    await this.undelegate(accountPda);
  }

  /**
   * Subscribe to account changes on ER
   */
  subscribeToER(
    accountPda: PublicKey,
    callback: (data: any) => void
  ): number {
    return this.erConnection.onAccountChange(accountPda, (accountInfo) => {
      try {
        const decoded = this.erProgram.coder.accounts.decode(
          "GameState", // Replace with your account type
          accountInfo.data
        );
        callback(decoded);
      } catch (e) {
        console.error("Failed to decode account:", e);
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Usage Example
async function main() {
  const wallet = Keypair.generate();
  const programId = new PublicKey("YourProgramId...");

  const manager = new DelegationManager(wallet, programId, IDL);

  const [accountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("account"), wallet.publicKey.toBuffer()],
    programId
  );

  // Initialize
  await manager.initialize(accountPda);

  // Execute with delegation
  await manager.executeWithDelegation(accountPda, [
    { method: "increment" },
    { method: "incrementBy", args: [5] },
    { method: "increment" },
  ]);

  console.log("Done!");
}

main().catch(console.error);
```

## State Diagram

```
                    ┌──────────────────┐
                    │   NOT_DELEGATED  │
                    │   (Base Layer)   │
                    └────────┬─────────┘
                             │
                     delegate()
                             │
                             ▼
                    ┌──────────────────┐
              ┌─────│    DELEGATED     │─────┐
              │     │      (ER)        │     │
              │     └──────────────────┘     │
              │              │               │
         execute()       commit()      undelegate()
              │              │               │
              │              ▼               │
              │     ┌──────────────────┐     │
              └────▶│    DELEGATED     │─────┘
                    │   (ER + Commit)  │
                    └──────────────────┘
                             │
                      undelegate()
                             │
                             ▼
                    ┌──────────────────┐
                    │   NOT_DELEGATED  │
                    │   (Finalized)    │
                    └──────────────────┘
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Delegation timeout` | Network delay | Increase timeout, retry |
| `Account not delegated` | Sent ER tx too early | Wait for delegation confirmation |
| `Undelegation timeout` | ER congestion | Increase timeout, check ER status |
| `Account still delegated` | Finalization pending | Wait longer before base layer reads |
