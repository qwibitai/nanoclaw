# Sanctum Program IDs

Complete reference for all Sanctum on-chain programs.

## Core Programs

### S Controller (Infinity Pool)

The central program managing the Infinity multi-LST liquidity pool.

```typescript
const S_CONTROLLER = '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx';
```

**Functions:**
- Manages LST reserves
- Updates SOL valuations
- Processes swaps
- Handles liquidity deposits/withdrawals
- Pool administration and rebalancing

### Pricing Programs

```typescript
// Current fee calculation program
const FLAT_SLAB = 's1b6NRXj6ygNu1QMKXh2H9LUR2aPApAAm1UQ2DjdhNV';

// Deprecated fee program
const FLAT_FEE_PRICING = 'f1tUoNEKrDp1oeGn4zxr7bh41eN6VcfHjfrL3ZqQday';
```

**Fee Structure:**
- Swap fee: 8 bps
- Withdrawal fee: 10 bps (20 bps at protocol level, 50% to LPs)
- Fee distribution: 90% to reserves, 10% to protocol

## SOL Value Calculator Programs

Programs that convert LST amounts to their intrinsic SOL value.

```typescript
const SOL_VALUE_CALCULATORS = {
  // Standard SPL stake pools
  SPL: 'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF',

  // Sanctum-deployed stake pools
  SanctumSpl: 'sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy',

  // Sanctum multi-validator stake pools
  SanctumSplMulti: 'ssmbu3KZxgonUtjEMCKspZzxvUQCxAFnyh1rcHUeEDo',

  // Marinade Finance (mSOL)
  Marinade: 'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP',

  // Lido (stSOL)
  Lido: '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR',

  // Wrapped SOL
  wSOL: 'wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE',
};
```

**How They Work:**
1. Read on-chain state of external staking protocol
2. Mirror internal pricing calculation
3. Factor in protocol fees
4. Return SOL value for given LST amount

## Stake Pool Programs

```typescript
const STAKE_POOLS = {
  // Standard Sanctum stake pool
  SanctumSpl: 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY',

  // Multi-validator stake pool
  SanctumSplMulti: 'SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn',

  // Solana Labs stake pool (base)
  SolanaStakePool: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
};
```

## Complete Program Map

```typescript
export const SANCTUM_PROGRAMS = {
  // Core
  sController: '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx',
  flatSlab: 's1b6NRXj6ygNu1QMKXh2H9LUR2aPApAAm1UQ2DjdhNV',
  flatFeePricing: 'f1tUoNEKrDp1oeGn4zxr7bh41eN6VcfHjfrL3ZqQday', // deprecated

  // SOL Value Calculators
  splSolValueCalc: 'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF',
  sanctumSplSolValueCalc: 'sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy',
  sanctumSplMultiSolValueCalc: 'ssmbu3KZxgonUtjEMCKspZzxvUQCxAFnyh1rcHUeEDo',
  marinadeSolValueCalc: 'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP',
  lidoSolValueCalc: '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR',
  wsolSolValueCalc: 'wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE',

  // Stake Pools
  sanctumSplStakePool: 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY',
  sanctumSplMultiStakePool: 'SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn',
  solanaStakePool: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
} as const;
```

## Router Instructions

The Router exposes these instructions for LST operations:

| Instruction | Description | Fee |
|-------------|-------------|-----|
| `StakeWrappedSol` | Stake SOL into pool, receive LST | 0 bps |
| `WithdrawWrappedSol` | Withdraw undelegated SOL from reserve | 1 bps |
| `DepositStake` | Deposit stake account, receive LST | 10 bps* |
| `WithdrawStake` | Prepare stake account for unstake | Varies |
| `SwapViaStake` | Swap LST A to LST B via shared validator | Varies |

*Waived if output is SOL via Reserve

## Authority Structure

| Authority | Count | Permissions |
|-----------|-------|-------------|
| Admin | 1 | Pool administration |
| Rebalancing | 1 | Reserve rebalancing |
| Disable | N | Pause pool operations |
| Pricing Manager | 1 | Manage pricing state |
| Protocol Fee Beneficiary | 1 | Receive protocol fees |

All programs are controlled by **Sanctum Multisig** with representatives from:
- Jito
- Jupiter
- Laine
- Mango
- MRGN
- Solblaze
- SolanaFM
- Sanctum

## TypeScript Usage

```typescript
import { PublicKey } from '@solana/web3.js';

// Create PublicKey instances
const sController = new PublicKey('5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx');

// Check if account is a Sanctum program
function isSanctumProgram(programId: PublicKey): boolean {
  const sanctumPrograms = Object.values(SANCTUM_PROGRAMS);
  return sanctumPrograms.some(p => new PublicKey(p).equals(programId));
}
```

## GitHub Repositories

Open source repositories at [github.com/igneous-labs](https://github.com/igneous-labs):

| Repository | Description |
|------------|-------------|
| `S` | Core S Controller implementation (archived, see inf-1.5) |
| `inf-1.5` | Current INF program development |
| `sanctum-unstake-program` | Unstake program |
| `sanctum-spl-token-sdk` | SPL Token SDK |
| `sanctum-system-sdk` | System program SDK |
| `sol-val-calc` | SOL value calculator SDK |
| `inf-jup-interface` | Jupiter AMM interface for INF |
| `solores` | Solana IDL to Rust generator |

## Verified Builds

Programs use verifiable builds via `solana-verify`:

```bash
# Verify program build
solana-verify verify-from-repo \
  --program-id 5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx \
  https://github.com/igneous-labs/S
```

## Technical Requirements

For building/testing locally:
- Solana: 1.17.6
- Rust: 1.73.0 (per solana-labs toolchain)
- Anchor: Latest compatible version
