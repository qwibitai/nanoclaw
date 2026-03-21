# Add QQ channel import

## Intent
Add the QQ channel self-registration import to the channels barrel file.

## Change
Append the QQ channel import after the existing channel imports.

## Invariants
- Keep existing channel imports unchanged
- Maintain the comment structure for each channel
- The import triggers the channel's `registerChannel()` call via side effect
