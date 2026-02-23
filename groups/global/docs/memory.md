# Global Memory Policy

Applies to updates in `groups/global/CLAUDE.md` and global lane memory artifacts.

## When To Store Globally

Store only durable, cross-lane facts that should apply to all groups.

Examples:

- stable user preference that affects all lanes
- persistent account or environment policy
- long-lived team operating rule

Do not store transient task notes, temporary status, or lane-specific implementation details.

## Update Discipline

1. Verify fact is cross-lane and durable.
2. Write concise canonical wording once.
3. Avoid duplicating the same fact in multiple files.
4. If memory change impacts workflow policy, also sync root docs per `docs/operations/agreement-sync-protocol.md`.
