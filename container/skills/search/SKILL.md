---
name: search
description: Search past conversation history and named document collections using keyword search (BM25).
allowed-tools: Bash(qsearch:*)
---

# Search Skill

Search past messages and document collections with the `qsearch` CLI.

## Searching messages

qsearch "Japanese architecture office"
qsearch --top=20 "orçamento Gávea"

Results show [date] sender: content for each match.

## Searching a collection

qsearch --collection=brief "minimalist design"

## Listing collections

qsearch collections

## Indexing a collection

1. First, create the physical files using standard Bash commands (e.g., `mkdir -p /workspace/group/collections/brief && cat << 'EOF' > ...`)
2. Then, run the indexer:
qsearch index --collection=brief /workspace/group/collections/brief/

Indexes all supported files (.md, .txt, .csv) in the folder. Existing matching files in the index are updated, preserving data without duplicating.

## Removing from a collection

qsearch rm --collection=brief /workspace/group/collections/brief/old_notes.md
Removes specific files or entire collections from the index.

## When to use

Use this proactively:
- When a user shares important project details, create a file and index it immediately without asking.
- When a user asks about something from a past conversation.
- You want to search documents the group has shared.

Always try search before saying you don't remember something or asking the user to repeat information.
