# feishu-typing-resilience Specification

## Purpose
TBD - created by archiving change upgrade-feishu-channel. Update Purpose after archive.
## Requirements
### Requirement: Typing Indicator Rate-Limit Circuit Breaker
FeishuChannel SHALL detect Feishu API rate-limit and quota-exceeded errors during typing indicator calls and enter a 5-minute backoff period, suppressing all further typing API calls for that instance until the cooldown expires.

#### Scenario: Thrown backoff error trips the breaker
- **WHEN** `im.messageReaction.create()` throws an error with code `99991400`, `99991403`, or `429` (in `err.code` or `err.response.data.code`)
- **THEN** `typingBackoffUntil` is set to `Date.now() + 300000` (5 minutes)
- **AND** the current `setTyping` call returns without propagating the error

#### Scenario: Non-throwing response with backoff code trips the breaker
- **WHEN** `im.messageReaction.create()` returns successfully but the response body contains `code: 99991400`, `99991403`, or `429`
- **THEN** `typingBackoffUntil` is set to `Date.now() + 300000`
- **AND** no reaction ID is stored

#### Scenario: Backoff suppresses typing calls
- **WHEN** `setTyping(jid, true)` is called while `Date.now() < typingBackoffUntil`
- **THEN** no Feishu API call is made
- **AND** the method returns immediately

#### Scenario: Backoff expires and calls resume
- **WHEN** `setTyping(jid, true)` is called after `typingBackoffUntil` has passed
- **THEN** the typing reaction API is called normally

#### Scenario: Non-backoff errors remain silently ignored
- **WHEN** `im.messageReaction.create()` throws any error that is NOT a backoff code (e.g., message deleted, permission denied)
- **THEN** the circuit breaker is NOT tripped
- **AND** the error is swallowed silently (existing behaviour preserved)

#### Scenario: Remove-reaction also checks for backoff codes
- **WHEN** `im.messageReaction.delete()` throws or returns a backoff code during `setTyping(jid, false)`
- **THEN** `typingBackoffUntil` is set accordingly
- **AND** the method returns without propagating the error

