---
name: research-cache
description: Manage and search the research cache for previously analyzed repositories
user-invocable: true
---

# Research Cache

Manage the global repository analysis cache used by the `/research` command.

## Overview

The research cache stores analysis results from external repositories discovered during web research. This prevents re-analyzing the same repositories and speeds up research workflows.

**Cache Location**: `~/.claude/research-cache/`

**Cache Structure**:
```
~/.claude/research-cache/
  <owner>-<repo>-<commit-short>/
    analysis.md          # Focused analysis document
    metadata.json        # Cache metadata (timestamps, query hash)
```

## Cache Behavior

### Automatic Caching

When the `/research` command discovers external repositories:

1. **Detection**: URLs extracted from web research results (Step 3.5)
2. **Cache Check**: Before analysis, check if commit already analyzed
3. **Analysis**: If not cached, spawn `focused-repository-analyzer` agent
4. **Save**: Analysis saved to cache with metadata
5. **Reuse**: Future research queries use cached results

### Cache TTL

- **Default TTL**: 7 days
- **Max Age**: 30 days (before purge)
- **Query Matching**: Cache reused if query hash matches

## Commands

### View Cache Statistics

```bash
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh stats
```

**Output**:
```
Cache Statistics

Directory: ~/.claude/research-cache

Entries:
  Total:   15
  Valid:   12
  Expired: 3
  Invalid: 0

Storage:
  Total Size: 45678KB

Configuration:
  TTL:          604800s (7 days)
  Max Age:      2592000s (30 days)
```

### List Cache Entries

```bash
# List valid entries only
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh list

# Include expired entries
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh list --expired
```

**Output**:
```
Cache Directory: ~/.claude/research-cache

CACHE KEY                      STATUS          CREATED              QUERY HASH
----------                     ------          -------              ----------
facebook-react-a1b2c3d         VALID           2026-01-01T12:00:00  f3a8c91e
vercel-next.js-e4f5g6h         VALID           2026-01-02T14:30:00  7b2d4a9c
golang-go-i7j8k9l              EXPIRED         2025-12-20T09:15:00  3c1e5f2a
```

### Purge Expired Entries

```bash
# Purge only expired entries (older than max age)
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge

# Force purge all entries
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge --force
```

**Output**:
```
Purging: golang-go-i7j8k9l (age: 2678400s)
Purging invalid: broken-repo-abc123

Purge Summary:
  Purged: 2
  Kept:   13
```

### Get Cached Analysis

```bash
# Get path to cached analysis
CACHE_KEY="facebook-react-a1b2c3d"
ANALYSIS_PATH=$(bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh get "$CACHE_KEY")

if [ $? -eq 0 ]; then
    echo "Found cached analysis: $ANALYSIS_PATH"
    cat "$ANALYSIS_PATH"
else
    echo "No cached analysis found"
fi
```

### Check Cache Existence

```bash
# Check if cache entry exists
CACHE_KEY="facebook-react-a1b2c3d"
if bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh exists "$CACHE_KEY"; then
    echo "Cache hit: $CACHE_KEY"
else
    echo "Cache miss: $CACHE_KEY"
fi

# Check with query hash matching
QUERY_HASH="f3a8c91e"
if bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh exists "$CACHE_KEY" "$QUERY_HASH"; then
    echo "Cache hit with matching query"
else
    echo "Cache miss or query mismatch"
fi
```

### Generate Cache Key

```bash
# Generate cache key from repo URL and commit
REPO_URL="https://github.com/facebook/react"
COMMIT_HASH="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"

CACHE_KEY=$(bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh key "$REPO_URL" "$COMMIT_HASH")
echo "Cache key: $CACHE_KEY"
# Output: facebook-react-a1b2c3d
```

## Cache Metadata

Each cache entry includes `metadata.json`:

```json
{
  "cache_key": "facebook-react-a1b2c3d",
  "repo_url": "https://github.com/facebook/react",
  "commit_hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
  "query": "How to implement React hooks?",
  "query_hash": "f3a8c91e",
  "context": "Discovered during web research for: React hooks implementation",
  "created_at": 1735747200,
  "created_date": "2026-01-01T12:00:00Z",
  "ttl_seconds": 604800,
  "expires_at": 1736352000,
  "expires_date": "2026-01-08T12:00:00Z"
}
```

## Best Practices

### When to Purge Cache

1. **Regular Maintenance**: Run `purge` monthly to remove old entries
2. **Disk Space**: Purge when cache size exceeds reasonable limits
3. **Forced Purge**: Use `--force` when resetting research state

### Cache Invalidation

Cache entries are automatically invalidated when:

- **Age > TTL**: Entry older than 7 days
- **Query Mismatch**: Different query hash (query-specific caching)
- **Invalid Metadata**: Missing or corrupted metadata.json

### Manual Cache Management

```bash
# View what's cached
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh list

# Check stats before purging
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh stats

# Purge expired only
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge

# Force clean slate
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge --force
```

## Configuration

### Environment Variables

```bash
# Override cache directory
export CLAUDE_RESEARCH_CACHE="/custom/cache/path"

# Default: ~/.claude/research-cache
```

### Cache Settings

Edit `toolkit/claude-code-4.5/utils/repo-analysis-cache.sh`:

```bash
# Cache TTL in seconds (7 days)
CACHE_TTL=$((7 * 24 * 60 * 60))

# Max age before purge (30 days)
MAX_CACHE_AGE=$((30 * 24 * 60 * 60))
```

## Troubleshooting

### Cache Not Being Used

**Symptom**: Research always re-analyzes repositories

**Check**:
```bash
# Verify cache exists
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh stats

# Check if entry is valid
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh exists <cache-key>
```

**Fix**:
- Entry may be expired (age > TTL)
- Query hash mismatch (different research query)
- Invalid metadata.json

### Cache Growing Too Large

**Symptom**: Cache directory consuming excessive disk space

**Check**:
```bash
# View cache size
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh stats
```

**Fix**:
```bash
# Purge expired entries
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge

# Or force purge all
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh purge --force
```

### Corrupted Cache Entry

**Symptom**: Cache entry exists but cannot be read

**Fix**:
```bash
# Manually remove corrupted entry
rm -rf ~/.claude/research-cache/<cache-key>

# Reinitialize cache
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh init
```

## Integration with /research Command

The research cache is automatically used by the `/research` command:

1. **Step 3.5**: External repositories detected from web research
2. **Step 3.6**: Cache checked before cloning/analyzing
3. **Cache Hit**: Cached analysis included in research document
4. **Cache Miss**: Repository cloned, analyzed, and saved to cache

No manual intervention required for normal research workflows.

## Performance Impact

**Without Cache**:
- Clone time: 30-60s per repository
- Analysis time: 25-35 minutes per repository
- Total: ~30 minutes for single repo

**With Cache**:
- Cache lookup: <1s
- Analysis reuse: instant
- Total: <1s for cached repo

**Typical Savings**: 99%+ time reduction for repeated research queries

## Advanced Usage

### Batch Cache Operations

```bash
# Get all valid cache keys
for cache_dir in ~/.claude/research-cache/*; do
    if [ -f "$cache_dir/metadata.json" ]; then
        CACHE_KEY=$(basename "$cache_dir")
        AGE=$(jq -r '.created_at' "$cache_dir/metadata.json")
        echo "$CACHE_KEY: created $(date -r $AGE)"
    fi
done
```

### Export Cache Statistics

```bash
# Export to JSON
bash toolkit/claude-code-4.5/utils/repo-analysis-cache.sh stats > cache-stats.txt

# Parse for monitoring
grep "Total:" cache-stats.txt
```

### Custom Cache Queries

```bash
# Find all React-related analyses
grep -r "React" ~/.claude/research-cache/*/analysis.md

# Find analyses newer than N days
find ~/.claude/research-cache -name "metadata.json" -mtime -7 -exec jq -r '.repo_url' {} \;
```

## See Also

- `/research` - Main research command that uses cache
- `focused-repository-analyzer` - Agent that generates cached analyses
- `toolkit/claude-code-4.5/utils/repo-analysis-cache.sh` - Cache utility script
