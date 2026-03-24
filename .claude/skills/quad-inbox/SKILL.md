---
name: quad-inbox
description: "Read and execute instructions left by Jorgenclaw in the quad-inbox directory. Use when Jorgenclaw says he left instructions for Quad."
user_invocable: true
---

# Quad Inbox

Read and execute all pending instructions from Jorgenclaw.

## Steps

1. List all `.md` files in `groups/main/quad-inbox/`
2. If empty, tell the user "No pending instructions from Jorgenclaw"
3. For each file:
   a. Read the file
   b. Display a brief summary of what it asks for
   c. Execute the instructions (file edits, commands, restarts)
   d. Report the result
   e. Delete the file after successful execution
4. If any instruction fails, stop and report the error — don't delete the file
5. Run `npm run build` if any TypeScript files were modified
6. Restart NanoClaw if any `src/` files or service configs were changed: `systemctl --user restart nanoclaw`
