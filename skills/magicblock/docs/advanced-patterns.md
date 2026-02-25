# Advanced MagicBlock Patterns

Advanced patterns and techniques for building with Ephemeral Rollups.

## Game Session Pattern

Manage player sessions with automatic delegation and cleanup.

```typescript
class GameSession {
  private delegatedAccounts: Set<string> = new Set();

  async startSession(playerPda: PublicKey) {
    // Initialize if needed
    const exists = await this.accountExists(playerPda);
    if (!exists) {
      await this.initializePlayer(playerPda);
    }

    // Delegate
    await this.delegate(playerPda);
    this.delegatedAccounts.add(playerPda.toBase58());

    // Setup auto-cleanup on disconnect
    this.setupCleanup(playerPda);
  }

  async endSession(playerPda: PublicKey) {
    if (this.delegatedAccounts.has(playerPda.toBase58())) {
      await this.undelegate(playerPda);
      this.delegatedAccounts.delete(playerPda.toBase58());
    }
  }

  async cleanupAll() {
    for (const pda of this.delegatedAccounts) {
      await this.undelegate(new PublicKey(pda));
    }
    this.delegatedAccounts.clear();
  }
}
```

## Multi-Account Delegation

Delegate multiple related accounts together.

```rust
// Rust: Delegate multiple accounts
pub fn delegate_game(ctx: Context<DelegateGame>) -> Result<()> {
    // Player account
    delegate_account(
        &ctx.accounts.payer,
        &ctx.accounts.player,
        &ctx.accounts.delegation_program,
        0, // no expiry
    )?;

    // Inventory account
    delegate_account(
        &ctx.accounts.payer,
        &ctx.accounts.inventory,
        &ctx.accounts.delegation_program,
        0,
    )?;

    // Stats account
    delegate_account(
        &ctx.accounts.payer,
        &ctx.accounts.stats,
        &ctx.accounts.delegation_program,
        0,
    )?;

    Ok(())
}
```

```typescript
// TypeScript: Verify all accounts delegated
async function verifyAllDelegated(accounts: PublicKey[]): Promise<boolean> {
  const results = await Promise.all(
    accounts.map((acc) => isDelegated(acc))
  );
  return results.every((r) => r === true);
}
```

## Optimistic Updates with Rollback

Show updates immediately, rollback on failure.

```typescript
class OptimisticState<T> {
  private confirmedState: T;
  private pendingUpdates: Array<{ id: string; update: Partial<T> }> = [];

  constructor(initialState: T) {
    this.confirmedState = initialState;
  }

  // Get current state with pending updates applied
  get state(): T {
    let current = { ...this.confirmedState };
    for (const pending of this.pendingUpdates) {
      current = { ...current, ...pending.update };
    }
    return current;
  }

  // Apply optimistic update
  optimisticUpdate(id: string, update: Partial<T>) {
    this.pendingUpdates.push({ id, update });
    return this.state;
  }

  // Confirm update
  confirm(id: string) {
    const index = this.pendingUpdates.findIndex((p) => p.id === id);
    if (index >= 0) {
      const update = this.pendingUpdates.splice(index, 1)[0];
      this.confirmedState = { ...this.confirmedState, ...update.update };
    }
  }

  // Rollback update
  rollback(id: string) {
    const index = this.pendingUpdates.findIndex((p) => p.id === id);
    if (index >= 0) {
      this.pendingUpdates.splice(index, 1);
    }
    return this.state;
  }
}

// Usage
const state = new OptimisticState({ gold: 100, health: 100 });

async function spendGold(amount: number) {
  const txId = generateId();

  // Optimistic update
  const newState = state.optimisticUpdate(txId, { gold: state.state.gold - amount });
  updateUI(newState);

  try {
    await erProgram.methods.spendGold(amount).rpc({ skipPreflight: true });
    state.confirm(txId);
  } catch (e) {
    // Rollback on failure
    const rolledBack = state.rollback(txId);
    updateUI(rolledBack);
    showError("Transaction failed");
  }
}
```

## Real-time Multiplayer Sync

Synchronize state across multiple clients.

```typescript
class MultiplayerSync {
  private localSequence = 0;
  private remoteSequence = 0;
  private pendingMoves: Map<number, Move> = new Map();

  // Send move with sequence number
  async sendMove(move: Move) {
    const seq = ++this.localSequence;
    this.pendingMoves.set(seq, move);

    // Apply locally immediately
    this.applyMove(move);

    // Send to ER
    await this.erProgram.methods
      .submitMove(move.data, seq)
      .rpc({ skipPreflight: true });
  }

  // Handle remote state update
  onStateUpdate(newState: GameState) {
    // Reconcile with pending moves
    this.remoteSequence = newState.lastSequence;

    // Remove confirmed moves
    for (const [seq, move] of this.pendingMoves) {
      if (seq <= this.remoteSequence) {
        this.pendingMoves.delete(seq);
      }
    }

    // Re-apply pending moves on top of confirmed state
    let state = newState;
    for (const [_, move] of this.pendingMoves) {
      state = this.predictMove(state, move);
    }

    this.updateUI(state);
  }
}
```

## Batched Operations

Batch multiple operations into single transactions.

```rust
// Rust: Batch update
pub fn batch_update(ctx: Context<BatchUpdate>, updates: Vec<UpdateData>) -> Result<()> {
    let state = &mut ctx.accounts.state;

    for update in updates {
        match update.op_type {
            OpType::AddItem => {
                state.inventory.push(update.item_id);
            }
            OpType::RemoveItem => {
                state.inventory.retain(|&x| x != update.item_id);
            }
            OpType::UpdateStat => {
                state.stats[update.stat_index] = update.value;
            }
        }
    }

    Ok(())
}
```

```typescript
// TypeScript: Batch client
async function batchOperations(operations: Operation[]) {
  const updates = operations.map((op) => ({
    opType: op.type,
    itemId: op.itemId ?? 0,
    statIndex: op.statIndex ?? 0,
    value: op.value ?? 0,
  }));

  await erProgram.methods
    .batchUpdate(updates)
    .rpc({ skipPreflight: true });
}

// Usage
await batchOperations([
  { type: "AddItem", itemId: 5 },
  { type: "UpdateStat", statIndex: 0, value: 100 },
  { type: "RemoveItem", itemId: 2 },
]);
```

## Conditional Delegation

Delegate only when needed, based on activity.

```typescript
class ConditionalDelegator {
  private isDelegated = false;
  private lastActivity = 0;
  private activityTimeout = 30000; // 30 seconds

  async ensureDelegated(accountPda: PublicKey) {
    if (!this.isDelegated) {
      await this.delegate(accountPda);
      this.isDelegated = true;
    }
    this.lastActivity = Date.now();
  }

  async execute(accountPda: PublicKey, method: string, args: any[]) {
    await this.ensureDelegated(accountPda);
    await this.erProgram.methods[method](...args).rpc({ skipPreflight: true });
  }

  // Auto-undelegate after inactivity
  startInactivityMonitor(accountPda: PublicKey) {
    setInterval(async () => {
      if (this.isDelegated && Date.now() - this.lastActivity > this.activityTimeout) {
        await this.undelegate(accountPda);
        this.isDelegated = false;
      }
    }, 5000);
  }
}
```

## State Snapshots

Periodic snapshots for recovery.

```rust
#[account]
pub struct StateWithSnapshot {
    pub current: StateData,
    pub snapshot: StateData,
    pub snapshot_slot: u64,
}

pub fn take_snapshot(ctx: Context<Snapshot>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.snapshot = state.current.clone();
    state.snapshot_slot = Clock::get()?.slot;
    Ok(())
}

pub fn restore_snapshot(ctx: Context<Restore>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.current = state.snapshot.clone();
    Ok(())
}
```

## Priority Queue for Actions

Process actions in priority order.

```rust
#[account]
pub struct ActionQueue {
    pub actions: Vec<QueuedAction>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct QueuedAction {
    pub priority: u8,      // 0 = highest
    pub action_type: u8,
    pub data: [u8; 32],
    pub timestamp: i64,
}

pub fn process_queue(ctx: Context<ProcessQueue>) -> Result<()> {
    let queue = &mut ctx.accounts.queue;

    // Sort by priority
    queue.actions.sort_by(|a, b| a.priority.cmp(&b.priority));

    // Process highest priority
    if let Some(action) = queue.actions.first() {
        execute_action(action)?;
        queue.actions.remove(0);
    }

    Ok(())
}
```

## Cross-Program Invocation on ER

CPI to other programs while on ER.

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn transfer_on_er(ctx: Context<TransferOnER>, amount: u64) -> Result<()> {
    // CPI to token program works on ER too
    let cpi_accounts = Transfer {
        from: ctx.accounts.from.to_account_info(),
        to: ctx.accounts.to.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

    token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```

## Error Recovery Pattern

Graceful error handling with retry logic.

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.log(`Attempt ${attempt + 1} failed:`, error.message);

      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }

  throw lastError!;
}

// Usage
await withRetry(
  () => erProgram.methods.increment().rpc({ skipPreflight: true }),
  3,
  1000
);
```
