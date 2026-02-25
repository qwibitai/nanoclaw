# Example API Reference

This file demonstrates the format for API reference documentation.

## Overview

API references should document all methods, their parameters, return types, and usage examples.

## Format Guidelines

### Method Documentation

Each method should include:

```markdown
### methodName

Description of what this method does.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| param1 | `string` | Yes | Description |
| param2 | `number` | No | Description |

**Returns:** `Promise<ReturnType>`

**Example:**

\`\`\`typescript
const result = await sdk.methodName(param1, param2);
\`\`\`
```

## Example: SDK Methods

### initialize

Initialize the SDK with connection and configuration.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| connection | `Connection` | Yes | Solana RPC connection |
| config | `Config` | No | Optional configuration |

**Returns:** `Promise<SDK>`

**Example:**

```typescript
import { SDK } from '@example/sdk';
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const sdk = await SDK.initialize(connection);
```

### getBalance

Get the balance for an account.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| address | `PublicKey` | Yes | Account address |

**Returns:** `Promise<number>`

**Example:**

```typescript
const balance = await sdk.getBalance(walletAddress);
console.log('Balance:', balance);
```

## Types Reference

### Config

```typescript
interface Config {
  commitment?: Commitment;
  timeout?: number;
  retries?: number;
}
```

### TransactionResult

```typescript
interface TransactionResult {
  signature: string;
  slot: number;
  confirmations: number;
}
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 1001 | InvalidInput | Input validation failed |
| 1002 | InsufficientFunds | Not enough balance |
| 1003 | TransactionFailed | Transaction did not confirm |

## Constants

```typescript
// Program ID
export const PROGRAM_ID = 'ExampleProgram111111111111111111111111111';

// Default configuration
export const DEFAULT_CONFIG: Config = {
  commitment: 'confirmed',
  timeout: 30000,
  retries: 3,
};
```
