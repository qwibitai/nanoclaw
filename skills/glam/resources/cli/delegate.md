# CLI: Delegate Commands (`glam-cli delegate`)

Manage access control and delegate permissions for vaults.

## Commands

### `glam-cli delegate grant`

Grant delegate permissions, scoped to a specific protocol.

```bash
glam-cli delegate grant <pubkey> <permissions...> --protocol <name> [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--protocol <NAME>` | Protocol to scope permissions to (e.g., `DriftProtocol`, `KaminoLend`, `JupiterSwap`, `SplToken`) |
| `-y, --yes` | Skip confirmation prompt |

**Available permissions by protocol:**

| Protocol | Permissions |
|----------|------------|
| **SystemProgram** | `WSOL`, `Transfer` |
| **JupiterSwap** | `SwapAny`, `SwapLST`, `SwapAllowlisted` |
| **SplToken** | `Transfer` |
| **CCTP** | `Transfer` |
| **GlamMint** | `MintTokens`, `BurnTokens`, `ForceTransfer`, `SetTokenAccountState`, `ClaimFees`, `Fulfill`, `EmergencyUpdate`, `CancelRequest`, `ClaimRequest` |
| **DriftProtocol** | `InitUser`, `UpdateUser`, `DeleteUser`, `Deposit`, `Withdraw`, `Borrow`, `Repay`, `CreateModifyOrders`, `CancelOrders`, `PerpMarkets`, `SpotMarkets` |
| **DriftVaults** | `Deposit`, `Withdraw` |
| **KaminoLend** | `Init`, `Deposit`, `Withdraw`, `Borrow`, `Repay` |
| **KaminoVaults** | `Deposit`, `Withdraw` |
| **KaminoFarms** | `Stake`, `Unstake`, `HarvestReward` |
| **Marinade** | `Stake`, `Unstake` |
| **StakeProgram** | `Stake`, `Unstake` |
| **StakePool** | `DepositSol`, `DepositStake`, `DepositSolAny`, `DepositStakeAny`, `WithdrawSol`, `WithdrawStake` |
| **SanctumSingle** | `DepositSol`, `DepositStake`, `DepositSolAny`, `DepositStakeAny`, `WithdrawSol`, `WithdrawStake` |
| **SanctumMulti** | `DepositSol`, `DepositStake`, `DepositSolAny`, `DepositStakeAny`, `WithdrawSol`, `WithdrawStake` |

**Examples:**

```bash
# Grant Kamino lending permissions (protocol-scoped)
glam-cli delegate grant <DELEGATE> Deposit Withdraw --protocol KaminoLend

# Grant Drift trading permissions
glam-cli delegate grant <DELEGATE> Deposit Withdraw CreateModifyOrders CancelOrders PerpMarkets --protocol DriftProtocol

# Grant Jupiter swap permissions
glam-cli delegate grant <DELEGATE> SwapAny --protocol JupiterSwap

# Grant transfer permissions
glam-cli delegate grant <DELEGATE> Transfer --protocol SplToken
```

### `glam-cli delegate list`

List vault delegates and their permissions.

```bash
glam-cli delegate list
```

### `glam-cli delegate revoke`

Revoke specific permissions from a delegate, scoped to a protocol.

```bash
glam-cli delegate revoke <pubkey> <permissions...> --protocol <name> [--yes]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--protocol <NAME>` | Protocol to scope revocation to |
| `-y, --yes` | Skip confirmation prompt |

**Examples:**

```bash
# Revoke specific Drift permissions
glam-cli delegate revoke <DELEGATE> PerpMarkets SpotMarkets --protocol DriftProtocol

# Revoke transfer permission
glam-cli delegate revoke <DELEGATE> Transfer --protocol SplToken
```

### `glam-cli delegate revoke-all`

Remove all delegate access for a specific delegate.

```bash
glam-cli delegate revoke-all <pubkey> [--yes]
```

---

## Fuzzy Matching

Protocol and permission names support fuzzy matching:

1. **Exact match** — `JupiterSwap`
2. **Case-insensitive** — `jupiterswap` → `JupiterSwap`
3. **Typo suggestion** — `JupiterSwp` → `Did you mean 'JupiterSwap'?`

This applies to `--protocol` values and permission names in `grant` and `revoke` commands.

---

## Common Patterns

### Trading Delegate Setup

```bash
# Drift trading permissions
glam-cli delegate grant <TRADER> Deposit Withdraw CreateModifyOrders CancelOrders PerpMarkets SpotMarkets --protocol DriftProtocol

# Also grant swap access
glam-cli delegate grant <TRADER> SwapAny --protocol JupiterSwap
```

### Yield Manager Setup

```bash
# Kamino lending permissions
glam-cli delegate grant <MANAGER> Init Deposit Withdraw Borrow Repay --protocol KaminoLend
```

### Staking Delegate Setup

```bash
# Marinade staking permissions
glam-cli delegate grant <STAKER> Stake Unstake --protocol Marinade
```

### Vault Operator Setup

```bash
# Kamino vault + farm permissions
glam-cli delegate grant <OPERATOR> Deposit Withdraw --protocol KaminoVaults
glam-cli delegate grant <OPERATOR> Stake Unstake HarvestReward --protocol KaminoFarms
```
