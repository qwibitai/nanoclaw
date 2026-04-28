# Verify: add-acurast-staking

## 1. Check MCP server is registered

In the group's `container.json`, confirm the `acurast-staking` key exists under `mcpServers`.

## 2. Ask k2 for a staking report

Send to k2 in Matrix:

```
@k2 run acurast_staking_report
```

Expected: A formatted markdown report with epoch number, staked amount, accrued reward, balances, and a Health: ✅ OK line.

## 3. Ask k2 for a compact summary

```
@k2 run acurast_staking_summary
```

Expected: A single line like:
```
✅ ACU epoch 2845 | staked 27,356.1900 ACU | accrued 0.4900 ACU | free 950.5300 ACU | health OK
```

## 4. Check agent container logs

On `unraid-syd`:

```bash
docker logs nanoclaw --tail 50 | grep acurast
```

Should show the MCP server initialising without errors.

## 5. Env var check

Confirm env vars are reaching the agent:

```bash
docker exec nanoclaw env | grep ACURAST
```

Expected:
```
ACURAST_ADDR=5F1e653pVJkb3kpeUXsRttHSdUxbnhuYAg2MAm6SKX29L2rK
ACURAST_COMMITMENT_ID=139
```
