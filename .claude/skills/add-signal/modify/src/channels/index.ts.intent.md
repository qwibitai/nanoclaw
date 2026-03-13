# Intent: add-signal channel registration

Add `import './signal.js';` to the channel barrel file, in alphabetical order
among the other channel imports. Place it after the marmot import and before
the slack import.

The import triggers SignalChannel's `registerChannel()` call at module load time,
making it available to the channel registry without any additional wiring.
