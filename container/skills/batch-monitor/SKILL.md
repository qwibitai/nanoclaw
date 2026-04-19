---
name: batch-monitor
description: Monitors AWS Batch job queues in the maff-sbir account, reports on running/failed jobs, and can submit new jobs with guardrails.
---

## Purpose

Query AWS Batch in the `maff-sbir` account, report job status across all queues, surface failures with log links, and optionally submit new jobs from a pre-approved allowlist.

## AWS configuration

- Profile: `sagri-mrv-maff-sbir`
- Region: `ap-northeast-1`

Set these for every `aws` call in this skill:

```bash
export AWS_PROFILE=sagri-mrv-maff-sbir
export AWS_DEFAULT_REGION=ap-northeast-1
```

## Approved job definitions

Only jobs from this allowlist may be submitted. Reject any request to submit a job outside this list.

- `mrv-tile-processor`
- `farmland-classifier`
- `soil-carbon-estimator`
- `sentinel2-downloader`
- `sar-preprocessor`

## Step-by-step instructions

### 1. List all job queues

```bash
aws batch describe-job-queues \
  --query 'jobQueues[*].{name:jobQueueName,state:state,status:status}' \
  --output json
```

### 2. Query jobs by status for each queue

For each queue, query active statuses: `SUBMITTED`, `PENDING`, `RUNNABLE`, `STARTING`, `RUNNING`. The `FAILED` status is handled separately in step 4.

```bash
aws batch list-jobs \
  --job-queue "$QUEUE_NAME" \
  --job-status "$STATUS" \
  --query 'jobSummaryList[*].{jobId:jobId,jobName:jobName,status:status,createdAt:createdAt,startedAt:startedAt,stoppedAt:stoppedAt,statusReason:statusReason}' \
  --output json
```

Compute duration as `stoppedAt - startedAt` where both are available. Express in minutes.

### 3. Detect stuck RUNNABLE jobs

A job is considered stuck if it has been in `RUNNABLE` status for an extended period. AWS Batch `list-jobs` does not expose the time a job entered RUNNABLE status — only `createdAt` (submission time) and `startedAt` (time execution began, unavailable while the job is still RUNNABLE). Because `createdAt` includes queue wait time before reaching RUNNABLE, use a threshold of **60 minutes** to reduce false positives from jobs that spend time in earlier statuses (SUBMITTED, PENDING) before reaching RUNNABLE.

```bash
NOW_MS=$(( $(date +%s) * 1000 ))
THRESHOLD_MS=$(( NOW_MS - 60 * 60 * 1000 ))
```

Flag any job where `createdAt < THRESHOLD_MS` and `status == "RUNNABLE"`. Note in the alert that this threshold is measured from job submission, not from when the job entered RUNNABLE, so the actual time in RUNNABLE may be shorter.

### 4. Fetch failed job details

For each `FAILED` job, retrieve the CloudWatch log stream URL and the last 20 log lines.

```bash
# Get log stream name from job description
LOG_STREAM=$(aws batch describe-jobs \
  --jobs "$JOB_ID" \
  --query 'jobs[0].container.logStreamName' \
  --output text)

# Fetch last 20 log lines
aws logs get-log-events \
  --log-group-name /aws/batch/job \
  --log-stream-name "$LOG_STREAM" \
  --limit 20 \
  --start-from-head false \
  --query 'events[*].message' \
  --output json
```

Construct the CloudWatch console URL:

```
https://ap-northeast-1.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1#logEventViewer:group=/aws/batch/job;stream=<LOG_STREAM>
```

### 5. Format the status report

Produce a Markdown table:

```
# AWS Batch Status — <datetime> (ap-northeast-1 / maff-sbir)

## Active Jobs
| Queue | Job Name | Status | Submit Time | Duration |
|-------|----------|--------|-------------|----------|
| mrv-queue | mrv-tile-processor-20240401 | RUNNING | 2024-04-01 03:00 UTC | 42 min |

## Failed Jobs
| Queue | Job Name | Submit Time | Reason | Logs |
|-------|----------|-------------|--------|------|
| mrv-queue | farmland-classifier-20240401 | 2024-04-01 01:00 UTC | Exit code 1 | [View logs](...) |

Last 20 log lines per failed job are included below the table.

## Alerts
- STUCK: <job name> submitted <N> minutes ago, still RUNNABLE in queue <queue> (threshold measured from submission time)
- FAILED after retry: <job name> in queue <queue>
```

### 6. Submit a new job (when requested)

Before submitting, enforce the following guardrails:

1. The job definition name must be in the approved allowlist above. Refuse if it is not.
2. Re-fetch the current active job count immediately before submitting by querying all queues for statuses `SUBMITTED`, `PENDING`, `RUNNABLE`, `STARTING`, and `RUNNING` (do not rely on the data collected in step 2). If the total is 5 or more, refuse and report the current count.
3. If the target queue name contains `prod` or `production`, require explicit written confirmation from the caller before proceeding. Do not submit silently.
4. Once all guardrails pass, submit:

```bash
aws batch submit-job \
  --job-name "$JOB_NAME" \
  --job-queue "$QUEUE_NAME" \
  --job-definition "$JOB_DEFINITION" \
  --parameters "$PARAMETERS_JSON"
```

Report the returned `jobId` to the caller.

## Error handling

- If `aws` returns an `AccessDenied` error, abort and report the exact error message. Do not attempt to retry with different credentials.
- If a log stream does not exist for a failed job, surface this as an explicit alert in the Alerts section (e.g. `- NO LOGS: <job name> — log stream not found`) rather than a quiet note in the table.
- Never silently swallow errors. Propagate all AWS CLI error messages to the caller.
