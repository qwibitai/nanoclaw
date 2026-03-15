---
name: usage-tracking
description: Track API costs and token usage by configurable categories, source channel, model, and auth mode. Triggers on "usage tracking", "track costs", "API costs", "token usage", "usage categories", or "/usage-tracking".
---

# Usage Tracking

Track API costs and token usage across your NanoClaw groups with configurable categories. Every agent invocation is logged with:

- **Category** (configurable per group: development, research, communication, etc.)
- **Source** (telegram, whatsapp, discord, slack, gmail, cron, terminal)
- **Model** (exact model ID used, with per-model token breakdown)
- **Auth mode** (api-key vs oauth/subscription)
- **Tokens** (input, output, cache read, cache create)
- **Cost** (USD, from the SDK)

## Phase 1: Pre-flight

Check if usage tracking is already applied. Use Node.js since `sqlite3` CLI may not be installed:

```bash
node -e "
const db = require('better-sqlite3')(require('./dist/config.js').STORE_DIR + '/messages.db');
const t = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='api_usage'\").get();
console.log(t ? 'Usage tracking is installed' : 'Not installed');
db.close();
"
```

If installed, skip to Phase 3 (Configure Categories).

## Phase 2: Apply

Merge the skill branch:

```bash
git fetch upstream skill/usage-tracking
git merge upstream/skill/usage-tracking
```

Then build:

```bash
npm run build
```

### Rebuild the container

```bash
./container/build.sh
```

If the build fails with a snapshot error, prune the builder cache first:

```bash
docker builder prune -f
./container/build.sh
```

### Delete stale per-group agent-runner copies

**Critical:** NanoClaw copies `container/agent-runner/src/` into each group's session directory the first time a group runs. These copies are mounted into the container and **override** the container's built-in source. After applying this skill, existing copies won't have the usage capture code.

Delete all stale copies so they get recreated with the new code:

```bash
rm -rf data/sessions/*/agent-runner-src/
```

### Restart the service

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 3: Configure Categories

### Understand the user's use case

Ask the user questions to determine which categories make sense for their setup:

1. **What do you use NanoClaw for?** (development, customer support, research, personal assistant, etc.)
2. **Do you have groups that serve different purposes?** (e.g., a dev group, a customer-facing group, an automation group)
3. **Do you want to track browser/research usage separately from coding tasks?**
4. **Any other cost dimensions you want to isolate?**

### Default categories

These are seeded automatically on first run:

| ID | Name | Description |
|----|------|-------------|
| `general` | General | Default for uncategorized usage |
| `development` | Development | Software development and coding tasks |
| `research` | Research | Web research and information gathering |
| `communication` | Communication | Customer emails, messages, and replies |
| `automation` | Automation | Scheduled tasks and automated workflows |

### Customize categories

Based on the user's answers, add, rename, or remove categories using Node.js:

```bash
node -e "
const db = require('better-sqlite3')(require('./dist/config.js').STORE_DIR + '/messages.db');

// Add a custom category
db.prepare('INSERT INTO usage_categories (id, name, description, created_at) VALUES (?, ?, ?, datetime(\"now\"))').run('browser', 'Browser Use', 'Web browsing and scraping tasks');

// List all categories
console.log(db.prepare('SELECT id, name, description FROM usage_categories').all());
db.close();
"
```

Other operations:

```bash
# Rename a category
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); db.prepare('UPDATE usage_categories SET name=?, description=? WHERE id=?').run('Customer Support','Emails and customer replies','communication'); db.close()"

# Remove a category (groups using it fall back to 'general')
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); db.prepare('UPDATE registered_groups SET usage_category=\"general\" WHERE usage_category=?').run('research'); db.prepare('DELETE FROM usage_categories WHERE id=?').run('research'); db.close()"
```

### Assign groups to categories

List current groups and assign categories:

```bash
node -e "
const db = require('better-sqlite3')(require('./dist/config.js').STORE_DIR + '/messages.db');
console.log('Current assignments:');
db.prepare('SELECT folder, name, usage_category FROM registered_groups').all()
  .forEach(g => console.log('  ' + g.folder + ' (' + g.name + ') -> ' + g.usage_category));
db.close();
"
```

Assign a group:

```bash
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); db.prepare('UPDATE registered_groups SET usage_category=? WHERE folder=?').run('development','main'); db.close()"
```

## Phase 4: Verify

Send a test message to any group, then check usage was recorded:

```bash
node -e "
const db = require('better-sqlite3')(require('./dist/config.js').STORE_DIR + '/messages.db');
const rows = db.prepare('SELECT category, source, model, cost_usd, input_tokens, output_tokens, timestamp FROM api_usage ORDER BY id DESC LIMIT 5').all();
console.table(rows);
db.close();
"
```

If no rows appear, check the troubleshooting section below.

### Query examples

Run any of these to analyze usage:

```bash
# Total cost by category
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.table(db.prepare('SELECT category, SUM(cost_usd) as total_cost, COUNT(*) as requests FROM api_usage GROUP BY category ORDER BY total_cost DESC').all()); db.close()"

# Cost by source channel
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.table(db.prepare('SELECT source, SUM(cost_usd) as total_cost, SUM(input_tokens) as total_in, SUM(output_tokens) as total_out FROM api_usage GROUP BY source').all()); db.close()"

# Cost by model
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.table(db.prepare('SELECT model, SUM(cost_usd) as total_cost, COUNT(*) as requests FROM api_usage WHERE model IS NOT NULL GROUP BY model').all()); db.close()"

# Daily cost breakdown
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.table(db.prepare('SELECT date(timestamp) as day, category, SUM(cost_usd) as cost FROM api_usage GROUP BY day, category ORDER BY day DESC').all()); db.close()"

# API key vs subscription comparison
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.table(db.prepare('SELECT auth_mode, SUM(cost_usd) as total_cost, COUNT(*) as requests FROM api_usage GROUP BY auth_mode').all()); db.close()"
```

## Changing Categories Later

Categories can be changed at any time. New invocations use the updated category; historical data retains the original category.

```bash
# Reassign a group
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); db.prepare('UPDATE registered_groups SET usage_category=? WHERE folder=?').run('research','browser-tasks'); db.close()"

# Add a new category
node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); db.prepare('INSERT INTO usage_categories (id,name,description,created_at) VALUES (?,?,?,datetime(\"now\"))').run('documents','Documents','PDF processing and document analysis'); db.close()"
```

## Troubleshooting

### No usage data appearing

1. **Stale agent-runner copies** (most common): Delete `data/sessions/*/agent-runner-src/` and restart. These per-group copies override the container's built-in code. If they predate the skill installation, they won't capture usage.
2. **Container not rebuilt:** Run `./container/build.sh` (prune first if it fails: `docker builder prune -f`)
3. **Service not restarted:** `systemctl --user restart nanoclaw` or `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
4. **Check container logs for usage capture:** `ls groups/main/logs/container-*.log | tail -1 | xargs grep "Usage:"`
5. **Verify table exists:** `node -e "const db=require('better-sqlite3')(require('./dist/config.js').STORE_DIR+'/messages.db'); console.log(db.prepare('SELECT sql FROM sqlite_master WHERE name=\"api_usage\"').get()); db.close()"`

### Cost shows 0

The SDK only reports cost when using API key auth. OAuth/subscription mode may report $0 for `total_cost_usd` since billing is handled differently. Token counts are always accurate regardless of auth mode.

### Container build fails with snapshot error

The Docker buildkit cache can get stale. Prune and retry:

```bash
docker builder prune -f
./container/build.sh
```
