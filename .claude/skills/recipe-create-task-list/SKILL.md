---
name: recipe-create-task-list
description: "Set up a new Google Tasks list with initial tasks."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "productivity"
    requires:
      bins:
        - gws
      skills:
        - gws-tasks
---

# Create a Task List and Add Tasks

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-tasks`

Set up a new Google Tasks list with initial tasks.

## Steps

1. Create task list: `gws tasks tasklists insert --json '{"title": "Q2 Goals"}'`
2. Add a task: `gws tasks tasks insert --params '{"tasklist": "TASKLIST_ID"}' --json '{"title": "Review Q1 metrics", "notes": "Pull data from analytics dashboard", "due": "2024-04-01T00:00:00Z"}'`
3. Add another task: `gws tasks tasks insert --params '{"tasklist": "TASKLIST_ID"}' --json '{"title": "Draft Q2 OKRs"}'`
4. List tasks: `gws tasks tasks list --params '{"tasklist": "TASKLIST_ID"}' --format table`

