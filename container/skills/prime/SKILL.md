---
name: prime
description: Load context for a new agent session by analyzing codebase structure and README
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# Prime

This command loads essential context for a new agent session by examining the codebase structure and reading the project README.

## Instructions
- Run `git ls-files` to understand the codebase structure and file organization
- Read the README.md to understand the project purpose, setup instructions, and key information
- Provide a concise overview of the project based on the gathered context

## Context
- Codebase structure git accessible: !`git ls-files`
- Codebase structure all: !`eza . --tree`
- Project README: @README.md
