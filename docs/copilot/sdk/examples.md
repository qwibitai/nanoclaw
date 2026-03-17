# Copilot CLI Extension Examples

A practical guide to writing extensions using the `@github/copilot-sdk` extension API.

## Extension Skeleton

Every extension starts with the same boilerplate:

```js
import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
    hooks: { /* ... */ },
    tools: [ /* ... */ ],
});
```

`joinSession` returns a `CopilotSession` object you can use to send messages and subscribe to events.

> **Platform notes (Windows vs macOS/Linux):**
> - Use `process.platform === "win32"` to detect Windows at runtime.
> - Clipboard: `pbcopy` on macOS, `clip` on Windows.
> - Use `exec()` instead of `execFile()` for `.cmd` scripts like `code`, `npx`, `npm` on Windows.
> - PowerShell stderr redirection uses `*>&1` instead of `2>&1`.

---

## Logging to the Timeline

Use `session.log()` to surface messages to the user in the CLI timeline:

```js
const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            await session.log("My extension loaded");
        },
        onPreToolUse: async (input) => {
            if (input.toolName === "bash") {
                await session.log(`Running: ${input.toolArgs?.command}`, { ephemeral: true });
            }
        },
    },
    tools: [],
});
```

Levels: `"info"` (default), `"warning"`, `"error"`. Set `ephemeral: true` for transient messages that aren't persisted.

---

## Registering Custom Tools

Tools are functions the agent can call. Define them with a name, description, JSON Schema parameters, and a handler.

### Basic tool

```js
tools: [
    {
        name: "my_tool",
        description: "Does something useful",
        parameters: {
            type: "object",
            properties: {
                input: { type: "string", description: "The input value" },
            },
            required: ["input"],
        },
        handler: async (args) => {
            return `Processed: ${args.input}`;
        },
    },
]
```

### Tool that invokes an external shell command

```js
import { execFile } from "node:child_process";

{
    name: "run_command",
    description: "Runs a shell command and returns its output",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
    },
    handler: async (args) => {
        const isWindows = process.platform === "win32";
        const shell = isWindows ? "powershell" : "bash";
        const shellArgs = isWindows
            ? ["-NoProfile", "-Command", args.command]
            : ["-c", args.command];
        return new Promise((resolve) => {
            execFile(shell, shellArgs, (err, stdout, stderr) => {
                if (err) resolve(`Error: ${stderr || err.message}`);
                else resolve(stdout);
            });
        });
    },
}
```

### Tool that calls an external API

```js
{
    name: "fetch_data",
    description: "Fetches data from an API endpoint",
    parameters: {
        type: "object",
        properties: {
            url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
    },
    handler: async (args) => {
        const res = await fetch(args.url);
        if (!res.ok) return `Error: HTTP ${res.status}`;
        return await res.text();
    },
}
```

### Tool handler invocation context

The handler receives a second argument with invocation metadata:

```js
handler: async (args, invocation) => {
    // invocation.sessionId  — current session ID
    // invocation.toolCallId — unique ID for this tool call
    // invocation.toolName   — name of the tool being called
    return "done";
}
```

---

## Hooks

Hooks intercept and modify behavior at key lifecycle points. Register them in the `hooks` option.

### Available Hooks

| Hook | Fires When | Can Modify |
|------|-----------|------------|
| `onUserPromptSubmitted` | User sends a message | The prompt text, add context |
| `onPreToolUse` | Before a tool executes | Tool args, permission decision, add context |
| `onPostToolUse` | After a tool executes | Tool result, add context |
| `onSessionStart` | Session starts or resumes | Add context, modify config |
| `onSessionEnd` | Session ends | Cleanup actions, summary |
| `onErrorOccurred` | An error occurs | Error handling strategy (retry/skip/abort) |

All hook inputs include `timestamp` (unix ms) and `cwd` (working directory).

### Modifying the user's message

Use `onUserPromptSubmitted` to rewrite or augment what the user typed before the agent sees it.

```js
hooks: {
    onUserPromptSubmitted: async (input) => {
        // Rewrite the prompt
        return { modifiedPrompt: input.prompt.toUpperCase() };
    },
}
```

### Injecting additional context into every message

Return `additionalContext` to silently append instructions the agent will follow.

```js
hooks: {
    onUserPromptSubmitted: async (input) => {
        return {
            additionalContext: "Always respond in bullet points. Follow our team coding standards.",
        };
    },
}
```

### Sending a follow-up message based on a keyword

Use `session.send()` to programmatically inject a new user message.

```js
hooks: {
    onUserPromptSubmitted: async (input) => {
        if (/\\burgent\\b/i.test(input.prompt)) {
            // Fire-and-forget a follow-up message
            setTimeout(() => session.send({ prompt: "Please prioritize this." }), 0);
        }
    },
}
```

> **Tip:** Guard against infinite loops if your follow-up message could re-trigger the same hook.

### Blocking dangerous tool calls

Use `onPreToolUse` to inspect and optionally deny tool execution.

```js
hooks: {
    onPreToolUse: async (input) => {
        if (input.toolName === "bash") {
            const cmd = String(input.toolArgs?.command || "");
            if (/rm\\s+-rf/i.test(cmd) || /Remove-Item\\s+.*-Recurse/i.test(cmd)) {
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason: "Destructive commands are not allowed.",
                };
            }
        }
        // Allow everything else
        return { permissionDecision: "allow" };
    },
}
```

### Modifying tool arguments before execution

```js
hooks: {
    onPreToolUse: async (input) => {
        if (input.toolName === "bash") {
            const redirect = process.platform === "win32" ? "*>&1" : "2>&1";
            return {
                modifiedArgs: {
                    ...input.toolArgs,
                    command: `${input.toolArgs.command} ${redirect}`,
                },
            };
        }
    },
}
```

### Reacting when the agent creates or edits a file

Use `onPostToolUse` to run side effects after a tool completes.

```js
import { exec } from "node:child_process";

hooks: {
    onPostToolUse: async (input) => {
        if (input.toolName === "create" || input.toolName === "edit") {
            const filePath = input.toolArgs?.path;
            if (filePath) {
                // Open the file in VS Code
                exec(`code "${filePath}"`, () => {});
            }
        }
    },
}
```

### Augmenting tool results with extra context

```js
hooks: {
    onPostToolUse: async (input) => {
        if (input.toolName === "bash" && input.toolResult?.resultType === "failure") {
            return {
                additionalContext: "The command failed. Try a different approach.",
            };
        }
    },
}
```

### Running a linter after every file edit

```js
import { exec } from "node:child_process";

hooks: {
    onPostToolUse: async (input) => {
        if (input.toolName === "edit") {
            const filePath = input.toolArgs?.path;
            if (filePath?.endsWith(".ts")) {
                const result = await new Promise((resolve) => {
                    exec(`npx eslint "${filePath}"`, (err, stdout) => {
                        resolve(err ? stdout : "No lint errors.");
                    });
                });
                return { additionalContext: `Lint result: ${result}` };
            }
        }
    },
}
```

### Handling errors with retry logic

```js
hooks: {
    onErrorOccurred: async (input) => {
        if (input.recoverable && input.errorContext === "model_call") {
            return { errorHandling: "retry", retryCount: 2 };
        }
        return {
            errorHandling: "abort",
            userNotification: `An error occurred: ${input.error}`,
        };
    },
}
```

### Session lifecycle hooks

```js
hooks: {
    onSessionStart: async (input) => {
        // input.source is "startup", "resume", or "new"
        return { additionalContext: "Remember to write tests for all changes." };
    },
    onSessionEnd: async (input) => {
        // input.reason is "complete", "error", "abort", "timeout", or "user_exit"
    },
}
```

---

## Session Events

After calling `joinSession`, use `session.on()` to react to events in real time.

### Listening to a specific event type

```js
session.on("assistant.message", (event) => {
    // event.data.content has the agent's response text
});
```

### Listening to all events

```js
session.on((event) => {
    // event.type and event.data are available for all events
});
```

### Unsubscribing from events

`session.on()` returns an unsubscribe function:

```js
const unsubscribe = session.on("tool.execution_complete", (event) => {
    // event.data.toolName, event.data.success, event.data.result, event.data.error
});

// Later, stop listening
unsubscribe();
```

### Example: Auto-copy agent responses to clipboard

Combine a hook (to detect a keyword) with a session event (to capture the response):

```js
import { execFile } from "node:child_process";

let copyNextResponse = false;

function copyToClipboard(text) {
    const cmd = process.platform === "win32" ? "clip" : "pbcopy";
    const proc = execFile(cmd, [], () => {});
    proc.stdin.write(text);
    proc.stdin.end();
}

const session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async (input) => {
            if (/\\bcopy\\b/i.test(input.prompt)) {
                copyNextResponse = true;
            }
        },
    },
    tools: [],
});

session.on("assistant.message", (event) => {
    if (copyNextResponse) {
        copyNextResponse = false;
        copyToClipboard(event.data.content);
    }
});
```

### Top 10 Most Useful Event Types

| Event Type | Description | Key Data Fields |
|-----------|-------------|-----------------|
| `assistant.message` | Agent's final response | `content`, `messageId`, `toolRequests` |
| `assistant.streaming_delta` | Token-by-token streaming (ephemeral) | `totalResponseSizeBytes` |
| `tool.execution_start` | A tool is about to run | `toolCallId`, `toolName`, `arguments` |
| `tool.execution_complete` | A tool finished running | `toolCallId`, `toolName`, `success`, `result`, `error` |
| `user.message` | User sent a message | `content`, `attachments`, `source` |
| `session.idle` | Session finished processing a turn | `backgroundTasks` |
| `session.error` | An error occurred | `errorType`, `message`, `stack` |
| `permission.requested` | Agent needs permission (shell, file write, etc.) | `requestId`, `permissionRequest.kind` |
| `session.shutdown` | Session is ending | `shutdownType`, `totalPremiumRequests`, `codeChanges` |
| `assistant.turn_start` | Agent begins a new thinking/response cycle | `turnId` |

### Example: Detecting when the plan file is created or edited

Use `session.workspacePath` to locate the session's `plan.md`, then `fs.watchFile` to detect changes.
Correlate `tool.execution_start` / `tool.execution_complete` events by `toolCallId` to distinguish agent edits from user edits.

```js
import { existsSync, watchFile, readFileSync } from "node:fs";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const agentEdits = new Set(); // toolCallIds for in-flight agent edits
const recentAgentPaths = new Set(); // paths recently written by the agent

const session = await joinSession();

const workspace = session.workspacePath; // e.g. ~/.copilot/session-state/<id>
if (workspace) {
    const planPath = join(workspace, "plan.md");
    let lastContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : null;

    // Track agent edits to suppress false triggers
    session.on("tool.execution_start", (event) => {
        if ((event.data.toolName === "edit" || event.data.toolName === "create")
            && String(event.data.arguments?.path || "").endsWith("plan.md")) {
            agentEdits.add(event.data.toolCallId);
            recentAgentPaths.add(planPath);
        }
    });
    session.on("tool.execution_complete", (event) => {
        if (agentEdits.delete(event.data.toolCallId)) {
            setTimeout(() => {
                recentAgentPaths.delete(planPath);
                lastContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : null;
            }, 2000);
        }
    });

    watchFile(planPath, { interval: 1000 }, () => {
        if (recentAgentPaths.has(planPath) || agentEdits.size > 0) return;
        const content = existsSync(planPath) ? readFileSync(planPath, "utf-8") : null;
        if (content === lastContent) return;
        const wasCreated = lastContent === null && content !== null;
        lastContent = content;
        if (content !== null) {
            session.send({
                prompt: `The plan was ${wasCreated ? "created" : "edited"} by the user.`,
            });
        }
    });
}
```

### Example: Reacting when the user manually edits any file in the repo

Use `fs.watch` with `recursive: true` on `process.cwd()` to detect file changes.
Filter out agent edits by tracking `tool.execution_start` / `tool.execution_complete` events.

```js
import { watch, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const agentEditPaths = new Set();

const session = await joinSession();

const cwd = process.cwd();
const IGNORE = new Set(["node_modules", ".git", "dist"]);

// Track agent file edits
session.on("tool.execution_start", (event) => {
    if (event.data.toolName === "edit" || event.data.toolName === "create") {
        const p = String(event.data.arguments?.path || "");
        if (p) agentEditPaths.add(resolve(p));
    }
});
session.on("tool.execution_complete", (event) => {
    // Clear after a delay to avoid race with fs.watch
    const p = [...agentEditPaths].find((x) => x); // any tracked path
    setTimeout(() => agentEditPaths.clear(), 3000);
});

const debounce = new Map();

watch(cwd, { recursive: true }, (eventType, filename) => {
    if (!filename || eventType !== "change") return;
    if (filename.split(/[\\\\\\/]/).some((p) => IGNORE.has(p))) return;

    if (debounce.has(filename)) clearTimeout(debounce.get(filename));
    debounce.set(filename, setTimeout(() => {
        debounce.delete(filename);
        const fullPath = join(cwd, filename);
        if (agentEditPaths.has(resolve(fullPath))) return;

        try { if (!statSync(fullPath).isFile()) return; } catch { return; }
        const relPath = relative(cwd, fullPath);
        session.send({
            prompt: `The user edited \\`${relPath}\\`.`,
            attachments: [{ type: "file", path: fullPath }],
        });
    }, 500));
});
```

---

## Sending Messages Programmatically

### Fire-and-forget

```js
await session.send({ prompt: "Analyze the test results." });
```

### Send and wait for the response

```js
const response = await session.sendAndWait({ prompt: "What is 2 + 2?" });
// response?.data.content contains the agent's reply
```

### Send with file attachments

```js
await session.send({
    prompt: "Review this file",
    attachments: [
        { type: "file", path: "./src/index.ts" },
    ],
});
```

---

## Permission and User Input Handlers

### Custom permission logic

```js
const session = await joinSession({
    onPermissionRequest: async (request) => {
        if (request.kind === "shell") {
            // request.fullCommandText has the shell command
            return { kind: "approved" };
        }
        if (request.kind === "write") {
            return { kind: "approved" };
        }
        return { kind: "denied-by-rules" };
    },
});
```

### Handling agent questions (ask_user)

Register `onUserInputRequest` to enable the agent's `ask_user` tool:

```js
const session = await joinSession({
    onUserInputRequest: async (request) => {
        // request.question has the agent's question
        // request.choices has the options (if multiple choice)
        return { answer: "yes", wasFreeform: false };
    },
});
```

---

## Complete Example: Multi-Feature Extension

An extension that combines tools, hooks, and events.

```js
import { execFile, exec } from "node:child_process";
import { joinSession } from "@github/copilot-sdk/extension";

const isWindows = process.platform === "win32";
let copyNextResponse = false;

function copyToClipboard(text) {
    const proc = execFile(isWindows ? "clip" : "pbcopy", [], () => {});
    proc.stdin.write(text);
    proc.stdin.end();
}

function openInEditor(filePath) {
    if (isWindows) exec(`code "${filePath}"`, () => {});
    else execFile("code", [filePath], () => {});
}

const session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async (input) => {
            if (/\\bcopy this\\b/i.test(input.prompt)) {
                copyNextResponse = true;
            }
            return {
                additionalContext: "Follow our team style guide. Use 4-space indentation.",
            };
        },
        onPreToolUse: async (input) => {
            if (input.toolName === "bash") {
                const cmd = String(input.toolArgs?.command || "");
                if (/rm\\s+-rf\\s+\\//i.test(cmd) || /Remove-Item\\s+.*-Recurse/i.test(cmd)) {
                    return { permissionDecision: "deny" };
                }
            }
        },
        onPostToolUse: async (input) => {
            if (input.toolName === "create" || input.toolName === "edit") {
                const filePath = input.toolArgs?.path;
                if (filePath) openInEditor(filePath);
            }
        },
    },
    tools: [
        {
            name: "copy_to_clipboard",
            description: "Copies text to the system clipboard.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to copy" },
                },
                required: ["text"],
            },
            handler: async (args) => {
                return new Promise((resolve) => {
                    const proc = execFile(isWindows ? "clip" : "pbcopy", [], (err) => {
                        if (err) resolve(`Error: ${err.message}`);
                        else resolve("Copied to clipboard.");
                    });
                    proc.stdin.write(args.text);
                    proc.stdin.end();
                });
            },
        },
    ],
});

session.on("assistant.message", (event) => {
    if (copyNextResponse) {
        copyNextResponse = false;
        copyToClipboard(event.data.content);
    }
});

session.on("tool.execution_complete", (event) => {
    // event.data.success, event.data.toolName, event.data.result
});
```

