# Example: Reentrancy Variant Hunt in Smart Contracts

Hunting for reentrancy vulnerabilities after discovering an initial finding in a DeFi protocol.

## Scenario

During an audit of a DeFi lending protocol, we found this classic reentrancy:

```solidity
// Original finding in contracts/Vault.sol:156
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount, "Insufficient balance");

    // Vulnerable: external call before state update
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success, "Transfer failed");

    balances[msg.sender] -= amount;  // State update AFTER external call
}
```

## Step 1: Root Cause Analysis

**Why is this vulnerable?**
- External call (`call{value: amount}`) can trigger fallback in attacker contract
- State (`balances`) is updated AFTER the external call
- Attacker can re-enter `withdraw()` before balance is decremented

**Pattern:**
```
check_balance → external_call → update_state
       ↑__________________________|
              (re-entry point)
```

**The fix pattern (Checks-Effects-Interactions):**
```
check_balance → update_state → external_call
```

## Step 2: Extract Search Patterns

### Pattern A: Call before state update
```bash
grep -rn '\.call{value' --include="*.sol" -A 5 | grep -B 5 '\-='
```

### Pattern B: Transfer patterns
```bash
grep -rn 'transfer\|\.call{value\|\.send(' --include="*.sol"
```

### Semgrep Rule
```yaml
rules:
  - id: reentrancy-state-after-call
    patterns:
      - pattern: |
          $X.call{value: ...}(...);
          ...
          $MAPPING[$KEY] -= ...;
      - pattern: |
          $X.call{value: ...}(...);
          ...
          $MAPPING[$KEY] = ...;
    message: "Potential reentrancy: state update after external call"
    languages: [solidity]
    severity: ERROR
```

### Slither Detector
```bash
slither . --detect reentrancy-eth,reentrancy-no-eth,reentrancy-benign
```

## Step 3: Search Results

### Slither Output
```
Vault.withdraw(uint256) (contracts/Vault.sol#156-165)
    External calls: msg.sender.call{value: amount}()
    State variables written after: balances[msg.sender]

LendingPool.liquidate(address,uint256) (contracts/LendingPool.sol#234-267)
    External calls: collateral.safeTransfer(msg.sender, seized)
    State variables written after: loans[borrower].collateral

Staking.unstake(uint256) (contracts/Staking.sol#89-102)
    External calls: rewardToken.transfer(msg.sender, pending)
    State variables written after: userInfo[msg.sender].rewardDebt

NFTVault.claimRewards() (contracts/NFTVault.sol#178-195)
    External calls: (success) = msg.sender.call{value: rewards}()
    State variables written after: lastClaim[msg.sender]
```

### Manual Grep Results
```
contracts/Vault.sol:160:        (bool success, ) = msg.sender.call{value: amount}("");
contracts/LendingPool.sol:256:  collateral.safeTransfer(msg.sender, seizedAmount);
contracts/Staking.sol:95:       rewardToken.transfer(msg.sender, pendingReward);
contracts/NFTVault.sol:188:     (bool success, ) = msg.sender.call{value: rewards}("");
contracts/Bridge.sol:134:       IERC20(token).safeTransfer(recipient, amount);
contracts/Governance.sol:89:    payable(proposer).transfer(refund);
```

## Step 4: Validate Each Finding

### Variant 1: LendingPool.liquidate (CONFIRMED)
```solidity
// contracts/LendingPool.sol:234-267
function liquidate(address borrower, uint256 repayAmount) external {
    Loan storage loan = loans[borrower];
    require(isLiquidatable(borrower), "Not liquidatable");

    uint256 seizedAmount = calculateSeizedCollateral(repayAmount);

    // External call to potentially malicious token
    collateral.safeTransfer(msg.sender, seizedAmount);  // EXTERNAL CALL

    // State updates after
    loan.debt -= repayAmount;
    loan.collateral -= seizedAmount;  // Written after external call!

    emit Liquidation(borrower, msg.sender, repayAmount, seizedAmount);
}
```

**Severity:** Critical
**Analysis:**
- `collateral` could be a malicious ERC20 with hook in `transfer()`
- Attacker deploys evil token as collateral
- On liquidation, evil token's transfer calls back into `liquidate()`
- Can drain all collateral before state updates

### Variant 2: Staking.unstake (CONFIRMED)
```solidity
// contracts/Staking.sol:89-102
function unstake(uint256 amount) external {
    UserInfo storage user = userInfo[msg.sender];
    require(user.amount >= amount, "Insufficient stake");

    uint256 pendingReward = calculateReward(msg.sender);

    // ERC20 transfer - potentially reentrancy via hooks (ERC777)
    rewardToken.transfer(msg.sender, pendingReward);

    user.amount -= amount;
    user.rewardDebt = user.amount * accRewardPerShare / 1e12;

    stakingToken.transfer(msg.sender, amount);
}
```

**Severity:** High
**Analysis:**
- If `rewardToken` is ERC777 (has transfer hooks), attacker can re-enter
- Double-claim rewards before `rewardDebt` is updated
- Also `stakingToken.transfer` after state could be exploited

### Variant 3: NFTVault.claimRewards (CONFIRMED)
```solidity
// contracts/NFTVault.sol:178-195
function claimRewards() external {
    uint256 rewards = pendingRewards[msg.sender];
    require(rewards > 0, "No rewards");

    // Native ETH transfer via call
    (bool success, ) = msg.sender.call{value: rewards}("");
    require(success, "Transfer failed");

    lastClaim[msg.sender] = block.timestamp;
    pendingRewards[msg.sender] = 0;  // Reset AFTER external call
}
```

**Severity:** Critical
**Analysis:**
- Classic ETH reentrancy pattern
- `pendingRewards` not zeroed before external call
- Attacker contract's receive() can call claimRewards() again

### Variant 4: Bridge.releaseFunds (FALSE POSITIVE)
```solidity
// contracts/Bridge.sol:128-142
function releaseFunds(bytes32 txHash, address token, address recipient, uint256 amount)
    external onlyRelayer
{
    require(!processed[txHash], "Already processed");
    processed[txHash] = true;  // State update BEFORE external call

    IERC20(token).safeTransfer(recipient, amount);

    emit FundsReleased(txHash, token, recipient, amount);
}
```

**Analysis:** FALSE POSITIVE - The `processed[txHash] = true` happens BEFORE the external call, following CEI pattern correctly.

### Variant 5: Governance.refundProposal (LOW RISK)
```solidity
// contracts/Governance.sol:85-95
function refundProposal(uint256 proposalId) external {
    Proposal storage proposal = proposals[proposalId];
    require(proposal.state == ProposalState.Defeated, "Not defeated");
    require(proposal.proposer == msg.sender, "Not proposer");

    uint256 refund = proposal.deposit;
    proposal.deposit = 0;  // State update BEFORE transfer

    payable(msg.sender).transfer(refund);  // Safe: uses transfer() with 2300 gas
}
```

**Severity:** Low (Informational)
**Analysis:**
- State updated before external call (good)
- Uses `transfer()` which only forwards 2300 gas (reentrancy resistant)
- However, `transfer()` is deprecated; recommend using CEI + `call{value}`

## Step 5: Summary

| Finding | Location | Severity | Status |
|---------|----------|----------|--------|
| Original | Vault.sol:156 | Critical | Confirmed |
| Variant 1 | LendingPool.sol:234 | Critical | Confirmed |
| Variant 2 | Staking.sol:89 | High | Confirmed |
| Variant 3 | NFTVault.sol:178 | Critical | Confirmed |
| Variant 4 | Bridge.sol:134 | - | False Positive |
| Variant 5 | Governance.sol:89 | Low | Informational |

**Total: 4 reentrancy vulnerabilities (3 Critical, 1 High)**

## Step 6: Remediation

### Systemic Fix: ReentrancyGuard
```solidity
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Vault is ReentrancyGuard {
    function withdraw(uint256 amount) external nonReentrant {
        // Now protected
    }
}
```

### Pattern Fix: Checks-Effects-Interactions
```solidity
// Fixed: contracts/Vault.sol
function withdraw(uint256 amount) external {
    // CHECKS
    require(balances[msg.sender] >= amount, "Insufficient balance");

    // EFFECTS (state changes BEFORE external calls)
    balances[msg.sender] -= amount;

    // INTERACTIONS (external calls LAST)
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success, "Transfer failed");
}
```

### Token-Specific: Use SafeERC20 + CEI
```solidity
// For ERC20/ERC777 tokens
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

function unstake(uint256 amount) external nonReentrant {
    UserInfo storage user = userInfo[msg.sender];

    // Effects first
    uint256 pendingReward = calculateReward(msg.sender);
    user.amount -= amount;
    user.rewardDebt = user.amount * accRewardPerShare / 1e12;

    // Interactions last
    SafeERC20.safeTransfer(rewardToken, msg.sender, pendingReward);
    SafeERC20.safeTransfer(stakingToken, msg.sender, amount);
}
```

### Prevention Checklist
1. Use `ReentrancyGuard` on all external functions with transfers
2. Follow CEI pattern: Checks → Effects → Interactions
3. Add reentrancy tests to test suite
4. Run Slither in CI/CD with `--detect reentrancy-*`
5. Review all ERC20/721/1155 interactions (token hooks!)
