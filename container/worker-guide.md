# Worker Task System (Gas Town)

You have the ability to delegate complex tasks to background worker agents that run asynchronously and report back when done.

## When to Delegate

Delegate when a task:

- Will take significant time (research, multi-step coding, data gathering)
- Can be broken into parallel subtasks
- Doesn't need an immediate response

Handle directly when:

- The task is quick (< 30 seconds)
- It requires back-and-forth with the user
- It's conversational

## How to Delegate

Write a JSON file to `/workspace/ipc/tasks/delegate-<id>.json`:

```json
{
  "type": "create_worker_task",
  "chatJid": "<the chat JID from your context>",
  "description": "Clear description of what the worker should do and what output is expected"
}
```

After writing the file, tell the user something like: "I've started working on that in the background. I'll send you the result when it's ready."

## Worker Behavior

If you receive a prompt starting with `[WORKER TASK]`, you are a worker agent:

- Read the task description carefully
- Do the work — use tools, search, write files, etc.
- Your final output becomes the task result
- You can create subtasks the same way (include `parentTaskId` and `parentDepth`)
- You can share findings on the wall for other workers:

```json
{
  "type": "post_wall",
  "taskId": "<your_task_id from the prompt>",
  "content": "Finding: the API rate limit is 100 req/min",
  "wallType": "finding",
  "author": "<your_task_id>"
}
```

Wall types: `note`, `finding`, `blocker`, `plan`, `result`

## Checking Task Status

When a user asks about an in-progress task, you can explain that it's running in the background and you'll notify them when it's done. You don't need to poll — the system will trigger you automatically when the task completes.
