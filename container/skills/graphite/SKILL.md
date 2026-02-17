---
name: graphite
description: Manage stacked pull requests using Graphite CLI. Create, submit, and restack PR chains.
---

# Graphite Stacked PRs

Use Graphite CLI to manage stacked pull requests - a workflow for breaking large features into smaller, dependent PRs.

## Commands

### Create a stack

```bash
# Create a new branch off current
gt create -m "First PR in stack"

# Make changes, commit
git add .
git commit -m "Implement feature A"

# Create next branch in stack
gt create -m "Second PR in stack"

# Make more changes
git add .
git commit -m "Implement feature B"
```

### Submit the stack

```bash
# Submit all branches as PRs
gt stack submit
```

This creates multiple PRs where each depends on the one before it.

### Restack after changes

If you make changes to an earlier PR in the stack:

```bash
# Switch to the branch you want to update
gt checkout <branch-name>

# Make changes
git add .
git commit -m "Update"

# Restack all dependent branches
gt stack restack
```

### View the stack

```bash
# Show current stack
gt stack

# Show detailed log
gt log
```

### Other useful commands

```bash
# List all branches
gt branch

# Delete a branch and restack
gt branch delete <branch-name>

# Sync with remote
gt stack sync
```

## Workflow Example

Building a feature that needs multiple PRs:

```bash
# Start from main
gt checkout main
gt sync

# Create first PR: database changes
gt create -m "Add user preferences table"
# ... make changes ...
git commit -m "Add migrations and models"

# Create second PR: backend API
gt create -m "Add preferences API endpoints"
# ... make changes ...
git commit -m "Implement CRUD endpoints"

# Create third PR: frontend
gt create -m "Add preferences UI"
# ... make changes ...
git commit -m "Build settings page"

# Submit the entire stack
gt stack submit
```

This creates 3 PRs:
1. Database changes (based on main)
2. API endpoints (based on #1)
3. UI (based on #2)

When #1 is merged, Graphite automatically restacks #2 and #3 on main.

## Tips

- Keep each PR focused and reviewable
- Write clear PR descriptions
- Use `gt stack` frequently to visualize your work
- When a PR is approved, merge it from GitHub - Graphite will handle the rest

## Authentication

Graphite CLI is pre-authenticated in NanoClaw containers using your GitHub token. No manual auth needed.

## Documentation

Full docs: https://graphite.com/docs
