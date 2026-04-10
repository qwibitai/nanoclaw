# KB Housekeeping

Weekly maintenance of the knowledge base. Runs Sunday 10 AM CST.

## Tasks

### 1. Expire Old Entries
Search KB for entries that haven't been retrieved recently:
- Email summaries older than 30 days
- Research findings older than 90 days
- Project decisions older than 180 days

Use `list_kb_documents()` and check creation dates. For entries past TTL, decide:
- If still relevant (active project, recent contact), keep
- If stale and not retrieved, archive or note for removal

### 2. Consolidate
Find multiple entries about the same project or topic.
Merge them into one richer entry:
- Combine 5 email summaries about "Q2 pricing" into one pricing narrative
- Use `upload_to_kb()` to create the consolidated entry
- Note which entries were consolidated

### 3. Budget Check
Count entries per project tag. If any project exceeds 50 entries:
- Identify lowest-value entries (oldest, least specific)
- Propose consolidation or removal

### 4. Report
Include in weekly review output:
- Entries expired: N
- Entries consolidated: N
- Budget warnings: [projects over limit]
- Total KB size: N documents

## Scheduled Task
- schedule_type: cron
- schedule_value: "0 10 * * 0" (Sunday 10 AM CST)
- context_mode: group
