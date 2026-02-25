# Pinocchio Optimization Checklist

Quick reference for maximizing performance in Pinocchio programs.

## Entrypoint Selection

| Use Case | Entrypoint | CU Savings |
|----------|------------|------------|
| Single instruction program | `lazy_program_entrypoint!` | ~1,800 CU |
| No heap needed | `no_allocator!` | ~500 CU |
| Multiple instructions | `entrypoint!` | Baseline |

```rust
// Best for simple programs
pinocchio::lazy_program_entrypoint!(process);

// Disable heap if not using Vec/String/Box
pinocchio::no_allocator!();
```

## Account Operations

### Do's

- [ ] Store PDA bump in account data
- [ ] Use `create_program_address` with known bump
- [ ] Direct lamport manipulation for program-owned accounts
- [ ] Single borrow, extract multiple fields
- [ ] Use bytemuck zero-copy

### Don'ts

- [ ] Don't call `find_program_address` in hot paths
- [ ] Don't borrow account data multiple times
- [ ] Don't use Borsh for fixed-size data
- [ ] Don't allocate in tight loops

## CU Cost Reference

| Operation | Pinocchio | Anchor |
|-----------|-----------|--------|
| Entrypoint overhead | ~200 | ~2,500 |
| Account deserialize | ~50 | ~500 |
| PDA find | ~1,500 | ~1,500 |
| PDA create (known bump) | ~100 | ~100 |
| SOL transfer (CPI) | ~150 | ~300 |
| SOL transfer (direct) | ~50 | N/A |
| Token transfer | ~4,000 | ~6,000 |

## Memory Optimization

```rust
// Fixed-size arrays instead of Vec
let buffer: [u8; 256] = [0; 256];

// Inline small values
#[repr(C)]
pub struct Compact {
    pub flags: u8,        // Pack multiple bools
    pub _pad: [u8; 7],
    pub value: u64,
}

// Avoid String - use fixed arrays
pub name: [u8; 32],       // Instead of String
```

## Serialization Choice

| Data Type | Use | CU Cost |
|-----------|-----|---------|
| Fixed size | Bytemuck | ~50 |
| Variable size | Borsh | ~200+ |
| Manual | Custom parser | ~20-100 |

## Quick Optimization Wins

1. **Use 1-byte discriminators** (not 8-byte like Anchor)
2. **Store bump** in account (avoid derivation)
3. **Direct lamport transfer** when possible
4. **Lazy entrypoint** for simple programs
5. **Pre-compute seeds** outside loops
6. **Single account borrow** per function
7. **Avoid heap** if possible

## Benchmark Template

```rust
use pinocchio::msg;

pub fn benchmark_operation() -> ProgramResult {
    let start = /* get compute units */;

    // Operation to benchmark

    let end = /* get compute units */;
    msg!("CU used: {}", start - end);

    Ok(())
}
```
