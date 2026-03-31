List and triage all pending files in the quad-inbox directory.

1. Find the quad-inbox directory. It's typically at one of:
   - `~/NanoClaw/groups/main/quad-inbox/`
   - `~/nanoclaw/groups/main/quad-inbox/`
   - Any path matching `groups/*/quad-inbox/`

2. List all `.md` files found, showing:
   - Filename
   - Age (days since last modified)
   - First line (the task title, e.g. `# Fix the thing`)
   - Status hint: mark files older than 3 days as STALE

3. If the inbox is empty, say so clearly.

4. Ask the user: "Would you like to run /quad-inbox to process these, or purge any stale files?"

Do not delete any files without explicit user confirmation.
