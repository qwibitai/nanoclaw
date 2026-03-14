# Intent: Add useDefaultCredentials to ContainerConfig

## What changed
Added optional `useDefaultCredentials?: boolean` field to the `ContainerConfig`
interface, with a default of `true`.

## Why
Groups need per-group configuration for whether they can fall back to the
default credential scope. Read by `resolveSecrets()` in the auth system.

## Invariants
- All existing fields unchanged
- All other interfaces unchanged
- The field is optional with a comment documenting the default
