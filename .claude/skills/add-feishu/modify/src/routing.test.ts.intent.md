# routing.test.ts Changes

## Purpose
Add tests for Feishu JID format support in the routing system.

## Changes

### JID Ownership Pattern Tests
Added a test case for Feishu JID format:
- Feishu JIDs start with `feishu:` prefix
- Example: `feishu:oc_xxxxxxxxxxxxxxxx`

### getAvailableGroups Tests
Added test case `includes Feishu groups when marked as groups`:
- Verifies Feishu group chats are included in available groups
- Tests both Feishu and WhatsApp groups can coexist

## Invariants
- Existing WhatsApp tests remain unchanged
- All existing assertions preserved
- New tests follow same patterns as existing tests
