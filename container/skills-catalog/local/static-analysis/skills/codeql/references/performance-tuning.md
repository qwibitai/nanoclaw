# Performance Tuning

## Memory Configuration

### CODEQL_RAM Environment Variable

Control maximum heap memory (in MB):

```bash
# 48GB for large codebases
CODEQL_RAM=48000 codeql database analyze codeql.db ...

# 16GB for medium codebases
CODEQL_RAM=16000 codeql database analyze codeql.db ...
```

**Guidelines:**
| Codebase Size | Recommended RAM |
|---------------|-----------------|
| Small (<100K LOC) | 4-8 GB |
| Medium (100K-1M LOC) | 8-16 GB |
| Large (1M+ LOC) | 32-64 GB |

## Thread Configuration

### Analysis Threads

```bash
# Use all available cores
codeql database analyze codeql.db --threads=0 ...

# Use specific number
codeql database analyze codeql.db --threads=8 ...
```

**Note:** `--threads=0` uses all available cores. For shared machines, use explicit count.

## Query-Level Timeouts

Prevent individual queries from running indefinitely:

```bash
# Set per-query timeout (in milliseconds)
codeql database analyze codeql.db --timeout=600000 ...
```

A 10-minute timeout (`600000`) catches runaway queries without killing legitimate complex analysis. Taint-tracking queries on large codebases may need longer.

## Evaluator Diagnostics

When analysis is slow, use `--evaluator-log` to identify which queries consume the most time:

```bash
codeql database analyze codeql.db \
  --evaluator-log=evaluator.log \
  --format=sarif-latest \
  --output=results.sarif \
  -- codeql/python-queries:codeql-suites/python-security-extended.qls

# Summarize the log
codeql generate log-summary evaluator.log --format=text
```

The summary shows per-query timing and tuple counts. Queries producing millions of tuples are likely the bottleneck.

## Disk Space

| Phase | Typical Size | Notes |
|-------|-------------|-------|
| Database creation | 2-10x source size | Compiled languages are larger due to build tracing |
| Analysis cache | 1-5 GB | Stored in database directory |
| SARIF output | 1-50 MB | Depends on finding count |

Check available space before starting:

```bash
df -h .
du -sh codeql_*.db 2>/dev/null
```

## Caching Behavior

CodeQL caches query evaluation results inside the database directory. Subsequent runs of the same queries skip re-evaluation.

| Scenario | Cache Effect |
|----------|-------------|
| Re-run same packs | Fast — uses cached results |
| Add new query pack | Only new queries evaluate |
| `codeql database cleanup` | Clears cache — forces full re-evaluation |
| `--rerun` flag | Ignores cache for this run |

**When to clear cache:**
- After deploying new data extensions (cache may hold stale results)
- When investigating unexpected zero-finding results
- Before benchmark comparisons (ensures consistent timing)

```bash
# Clear evaluation cache
codeql database cleanup codeql_1.db
```

## Troubleshooting Performance

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| OOM during analysis | Not enough RAM | Increase `CODEQL_RAM` |
| Slow database creation | Complex build | Use `--threads`, simplify build |
| Slow query execution | Large codebase | Reduce query scope, add RAM |
| Database too large | Too many files | Use exclusion config (`codeql-config.yml` with `paths-ignore`) |
| Single query hangs | Runaway evaluation | Use `--timeout` and check `--evaluator-log` |
| Repeated runs still slow | Cache not used | Check you're using same database path |
