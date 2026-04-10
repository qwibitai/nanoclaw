# Weekly Review

Generate a comprehensive week-in-review report. Runs Friday 5 PM CST.

## Data Sources

### 1. Activity Stats
Query the SQLite database for this week's activity:
```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT action_taken, COUNT(*) 
  FROM processed_items 
  WHERE processed_at > datetime('now', '-7 days')
  GROUP BY action_taken;
"
```

### 2. Autonomy Stats
Calculate the percentage of AUTO vs PROPOSE vs ESCALATE actions.
Query approval_log for this week:
```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT outcome, COUNT(*) 
  FROM approval_log 
  WHERE timestamp > datetime('now', '-7 days')
  GROUP BY outcome;
"
```

### 3. Open Commitments
```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT description, person, due_date, direction
  FROM commitments 
  WHERE status = 'open'
  ORDER BY due_date;
"
```

### 4. Graduation Candidates
```bash
sqlite3 /workspace/project/store/messages.db "
  WITH ranked AS (
    SELECT action_type, outcome,
      ROW_NUMBER() OVER (PARTITION BY action_type ORDER BY timestamp DESC) as rn
    FROM approval_log
  )
  SELECT action_type, COUNT(*) as streak
  FROM ranked
  WHERE rn <= 5 AND outcome = 'approved'
  GROUP BY action_type
  HAVING COUNT(*) = 5;
"
```

### 5. Knowledge Stats
Use list_kb_documents() to count KB entries. Note recent additions.

## Format

```
Week in Review (April 7-11, 2026)

ACTIVITY
• Emails processed: N
• Calendar events created: N
• Research tasks: N
• GitHub issues: N

AUTONOMY
• Auto-handled: N (X%)
• Proposed: N (X%)
• Escalated: N (X%)
• Trend: [up/down] from last week

OPEN COMMITMENTS (N)
• Mine: [list with due dates]
• Theirs: [list with due dates]

GRADUATION CANDIDATES
• [action_type]: 5 consecutive approvals — ready to promote?

KNOWLEDGE
• KB entries added: N
• [Include note about any housekeeping needed]
```

## Scheduled Task

- schedule_type: cron
- schedule_value: "0 17 * * 5" (Friday 5 PM CST)
- context_mode: group
