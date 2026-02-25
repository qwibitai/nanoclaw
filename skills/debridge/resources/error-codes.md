# deBridge Error Codes Reference

Complete reference for SDK error types and handling.

## Error Enum

The SDK defines an `Error` enum with validation-related variants.

### Claim Parent Validation Errors

Errors related to validating parent claim instructions:

| Error | Description |
|-------|-------------|
| `WrongClaimParentInstruction` | Parent instruction format is invalid |
| `WrongClaimParentInstructionAccounts` | Incorrect accounts in parent instruction |
| `WrongClaimParentSubmission` | Invalid submission data |
| `WrongClaimParentSubmissionAuth` | Submission authority mismatch |
| `WrongClaimParentProgramId` | Wrong program ID in parent |
| `WrongClaimParentClaimer` | Claimer address doesn't match |
| `WrongClaimParentReceiver` | Receiver address doesn't match |
| `WrongClaimParentFallbackAddress` | Fallback address doesn't match |
| `WrongClaimParentTokenMint` | Token mint doesn't match |
| `WrongClaimParentSourceChainId` | Source chain ID doesn't match |
| `WrongClaimParentSubmissionAccountKey` | Submission account key mismatch |
| `WrongClaimParentNativeSender` | Native sender address doesn't match |

### Account Errors

| Error | Description |
|-------|-------------|
| `AccountDeserializeError` | Failed to deserialize account data |
| `WrongAccountDiscriminator` | Account has incorrect discriminator |
| `WrongAccountIndex` | Account at wrong index in array |
| `AccountBorrowFailing` | Failed to borrow account data |

### Program Errors

| Error | Description |
|-------|-------------|
| `WrongDebridgeProgram` | Incorrect deBridge program ID |
| `WrongSettingProgramId` | Incorrect settings program ID |
| `WrongDebridgeProgramId` | deBridge program ID validation failed |

### State Errors

| Error | Description |
|-------|-------------|
| `WrongState` | Protocol state is invalid |
| `ExternalStorageWrongState` | External call storage in wrong state |

### Chain & Fee Errors

| Error | Description |
|-------|-------------|
| `WrongChainSupportInfo` | Chain support info account invalid |
| `TargetChainNotSupported` | Destination chain is not supported |
| `WrongBridgeFeeInfo` | Bridge fee info account invalid |
| `AssetFeeNotSupported` | Asset fee not available for chain |
| `AmountOverflowedWhileAddingFee` | Fee calculation caused overflow |

### Other Errors

| Error | Description |
|-------|-------------|
| `FailedToGetRent` | Could not retrieve rent exemption |
| `SubmissionAuthValidationFailed` | Submission authority validation failed |

## InvokeError

Wrapper type for SDK and Solana program errors:

```rust
pub enum InvokeError {
    SdkError(Error),
    ProgramError(ProgramError),
}

impl From<Error> for InvokeError {
    fn from(e: Error) -> Self {
        InvokeError::SdkError(e)
    }
}

impl From<ProgramError> for InvokeError {
    fn from(e: ProgramError) -> Self {
        InvokeError::ProgramError(e)
    }
}
```

## Error Handling Patterns

### Basic Error Handling

```rust
use debridge_solana_sdk::errors::Error;

pub fn send_with_error_handling(
    ctx: Context<Send>,
    target_chain_id: [u8; 32],
    receiver: Vec<u8>,
    amount: u64,
) -> Result<()> {
    // Check chain support first
    let is_supported = debridge_sending::is_chain_supported(
        &target_chain_id,
        ctx.remaining_accounts,
    ).map_err(|e| {
        msg!("Chain support check failed: {:?}", e);
        error!(ErrorCode::ChainCheckFailed)
    })?;

    if !is_supported {
        return Err(error!(ErrorCode::UnsupportedChain));
    }

    // Attempt send
    debridge_sending::invoke_debridge_send(
        debridge_sending::SendIx {
            target_chain_id,
            receiver,
            is_use_asset_fee: false,
            amount,
            submission_params: None,
            referral_code: None,
        },
        ctx.remaining_accounts,
    ).map_err(|e| {
        msg!("deBridge send failed: {:?}", e);
        error!(ErrorCode::SendFailed)
    })?;

    Ok(())
}
```

### Claim Validation Error Handling

```rust
use debridge_solana_sdk::check_claiming::*;
use debridge_solana_sdk::errors::Error;

pub fn receive_with_validation(
    ctx: Context<Receive>,
    expected_sender: Vec<u8>,
    expected_chain: [u8; 32],
) -> Result<()> {
    let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()
        .map_err(|e| {
            msg!("Failed to get claim instruction: {:?}", e);
            error!(ErrorCode::InvalidClaimInstruction)
        })?;

    let validation = SubmissionAccountValidation {
        native_sender_validation: Some(expected_sender),
        source_chain_id_validation: Some(expected_chain),
        receiver_validation: Some(ctx.accounts.receiver.key()),
        ..Default::default()
    };

    claim_ix.validate_submission_account(
        &ctx.accounts.submission,
        &validation,
    ).map_err(|e| {
        match e {
            Error::WrongClaimParentNativeSender => {
                msg!("Sender mismatch");
                error!(ErrorCode::UnauthorizedSender)
            }
            Error::WrongClaimParentSourceChainId => {
                msg!("Wrong source chain");
                error!(ErrorCode::InvalidSourceChain)
            }
            Error::WrongClaimParentReceiver => {
                msg!("Receiver mismatch");
                error!(ErrorCode::InvalidReceiver)
            }
            _ => {
                msg!("Validation failed: {:?}", e);
                error!(ErrorCode::ValidationFailed)
            }
        }
    })?;

    Ok(())
}
```

### Fee Calculation Error Handling

```rust
pub fn calculate_fees_safely(
    ctx: Context<CalculateFees>,
    amount: u64,
    target_chain_id: [u8; 32],
) -> Result<u64> {
    // Check for overflow when adding fees
    let total = debridge_sending::add_all_fees(
        amount,
        &target_chain_id,
        ctx.remaining_accounts,
    ).map_err(|e| {
        match e {
            Error::AmountOverflowedWhileAddingFee => {
                msg!("Amount too large, fee overflow");
                error!(ErrorCode::AmountTooLarge)
            }
            Error::AssetFeeNotSupported => {
                msg!("Asset fee not supported for chain");
                error!(ErrorCode::AssetFeeUnavailable)
            }
            Error::TargetChainNotSupported => {
                msg!("Target chain not supported");
                error!(ErrorCode::UnsupportedChain)
            }
            _ => {
                msg!("Fee calculation error: {:?}", e);
                error!(ErrorCode::FeeCalculationFailed)
            }
        }
    })?;

    Ok(total)
}
```

## Custom Error Codes

Define your own error codes for deBridge-related failures:

```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Target chain is not supported")]
    UnsupportedChain,

    #[msg("Chain support check failed")]
    ChainCheckFailed,

    #[msg("Cross-chain send failed")]
    SendFailed,

    #[msg("Invalid claim instruction")]
    InvalidClaimInstruction,

    #[msg("Unauthorized sender")]
    UnauthorizedSender,

    #[msg("Invalid source chain")]
    InvalidSourceChain,

    #[msg("Invalid receiver")]
    InvalidReceiver,

    #[msg("Submission validation failed")]
    ValidationFailed,

    #[msg("Amount too large for fee calculation")]
    AmountTooLarge,

    #[msg("Asset fee not available")]
    AssetFeeUnavailable,

    #[msg("Fee calculation failed")]
    FeeCalculationFailed,

    #[msg("External call initialization failed")]
    ExternalCallInitFailed,

    #[msg("External call storage in wrong state")]
    ExternalCallWrongState,
}
```

## TypeScript Error Handling

```typescript
import { AnchorError, ProgramError } from '@coral-xyz/anchor';

async function sendWithErrorHandling(
  program: Program,
  params: SendParams,
) {
  try {
    const tx = await program.methods
      .sendViaDebridge(params)
      .rpc();
    return tx;
  } catch (error) {
    if (error instanceof AnchorError) {
      switch (error.error.errorCode.code) {
        case 'UnsupportedChain':
          console.error('Chain not supported by deBridge');
          break;
        case 'AssetFeeUnavailable':
          console.error('Cannot use asset fee for this chain');
          break;
        case 'AmountTooLarge':
          console.error('Amount would overflow with fees');
          break;
        default:
          console.error('Program error:', error.error.errorMessage);
      }
    } else if (error instanceof ProgramError) {
      console.error('Solana program error:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
    throw error;
  }
}
```

## Common Error Scenarios

### 1. Chain Not Supported

```rust
// Check before sending
if !debridge_sending::is_chain_supported(&target_chain_id, accounts)? {
    return Err(error!(ErrorCode::UnsupportedChain));
}
```

### 2. Insufficient Amount for Fees

```rust
// Calculate total with fees first
let total_needed = debridge_sending::add_all_fees(amount, &chain_id, accounts)?;
if user_balance < total_needed {
    return Err(error!(ErrorCode::InsufficientBalance));
}
```

### 3. Wrong Accounts Order

```rust
// Ensure accounts are in correct order
// The SDK expects specific account indices
// See program-ids.md for required account order
```

### 4. External Call State Mismatch

```rust
// External call storage must be in correct state
// Initialize before use, validate state before operations
```
