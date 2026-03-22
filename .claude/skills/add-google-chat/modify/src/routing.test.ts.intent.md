# Intent: src/routing.test.ts modifications

## What changed

Added Google Chat JID pattern tests and group list exclusion tests.

## Key sections

### JID ownership patterns

- Added two tests verifying `gchat:` prefix pattern for Google Chat JIDs (space IDs)

### getAvailableGroups

- Added test verifying Google Chat DMs (`is_group: false`) are excluded from the available groups list, same as Gmail threads and WhatsApp DMs

## Invariants

- All existing WhatsApp and Gmail JID pattern tests are unchanged
- All existing getAvailableGroups tests are unchanged
- Test setup (beforeEach with _initTestDatabase) is unchanged

## Must-keep

- The `beforeEach` block that initializes a fresh test database
- All existing JID pattern tests (WhatsApp group, WhatsApp DM, Gmail)
- All existing getAvailableGroups tests (ordering, registration marking, sentinel exclusion)
