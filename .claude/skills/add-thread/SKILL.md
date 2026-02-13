---
name: add-thread
description: Create a new discussion thread in the current group based on user-provided information. Organizes conversations by topic in separate folders.
---

# Add Thread

This skill creates a new discussion thread within the current group. Each thread gets its own folder for organizing conversations, files, and context by topic.

## Usage

When the user wants to create a new thread, they'll provide:
1. **Thread name** - A descriptive name (e.g., "Customer Support Bot", "Marketing Campaign")
2. **Purpose/description** - What this thread is for
3. **Optional context** - Any initial instructions or context for this thread

## Implementation

### Step 1: Gather Information

Ask the user for:
- Thread name (will be used for folder naming)
- Brief description/purpose
- Any initial context or instructions (optional)

### Step 2: Create Thread Structure

Create a new folder under the current group's directory:

```bash
# Convert thread name to folder-safe format (lowercase, hyphens)
THREAD_NAME="user-provided-name"
FOLDER_NAME=$(echo "$THREAD_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
GROUP_DIR="/workspace/group"

mkdir -p "$GROUP_DIR/threads/$FOLDER_NAME"
```

### Step 3: Create Thread Configuration

Create a `THREAD.md` file with the thread's purpose and context:

```bash
cat > "$GROUP_DIR/threads/$FOLDER_NAME/THREAD.md" << 'EOF'
# THREAD_NAME

## Purpose
DESCRIPTION_HERE

## Context
CONTEXT_HERE (if provided)

## Created
TIMESTAMP

---

This thread is part of the LoadX Logistics LLC workspace.
All conversations and files related to this topic should be kept here.
EOF
```

### Step 4: Create Conversations Folder

Each thread should have its own conversations folder:

```bash
mkdir -p "$GROUP_DIR/threads/$FOLDER_NAME/conversations"
mkdir -p "$GROUP_DIR/threads/$FOLDER_NAME/files"
```

### Step 5: Update Thread Index

Create or update a threads index file at `/workspace/group/THREADS.md`:

```bash
# If THREADS.md doesn't exist, create it with header
if [ ! -f "$GROUP_DIR/THREADS.md" ]; then
  cat > "$GROUP_DIR/THREADS.md" << 'EOF'
# Discussion Threads

This file tracks all discussion threads in this group.

EOF
fi

# Append the new thread
cat >> "$GROUP_DIR/THREADS.md" << EOF

## $THREAD_NAME
- Folder: \`threads/$FOLDER_NAME\`
- Created: TIMESTAMP
- Purpose: DESCRIPTION_HERE

EOF
```

### Step 6: Confirm to User

Tell the user:

> Thread created: *THREAD_NAME*
>
> Location: `threads/FOLDER_NAME`
>
> To work on this thread, you can:
> • Ask me to "switch to THREAD_NAME thread"
> • Reference files in the thread: "Check threads/FOLDER_NAME/file.txt"
> • Keep topic-specific conversations and files organized here

## Thread Management

### Listing Threads

To show all threads:

```bash
cat /workspace/group/THREADS.md
```

Or list thread folders:

```bash
ls -1 /workspace/group/threads/
```

### Switching Threads

When the user says "switch to X thread" or "work on X thread":
1. Read the thread's `THREAD.md` to understand the context
2. Set that as the working context for subsequent messages
3. Use the thread's folders for file operations

### Deleting Threads

If the user wants to delete a thread:
1. Ask for confirmation
2. Remove the thread folder: `rm -rf /workspace/group/threads/FOLDER_NAME`
3. Update `THREADS.md` to remove the entry

## Example

User says: "Create a thread for customer support automation project"

You would:
1. Create `/workspace/group/threads/customer-support-automation/`
2. Create `THREAD.md` with the purpose
3. Create `conversations/` and `files/` subfolders
4. Update `THREADS.md` index
5. Confirm the thread is ready

## Notes

- Thread names should be descriptive but concise
- Each thread is isolated from others
- The main group folder remains for general/non-threaded content
- Threads help organize complex projects with multiple workstreams
- Use threads when you need to keep conversations and files separate from the main group context
