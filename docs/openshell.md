# Running NanoClaw in NVIDIA OpenShell

NanoClaw supports [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) as an alternative execution backend for agent sandboxes.

OpenShell is a private runtime that creates and manages sandboxes for AI agents. It intercepts network traffic via a Gateway to enforce declarative YAML policies, ensuring the agents can only perform authorized actions and access allowed endpoints.

This brings features from NemoClaw directly into NanoClaw:

- **Security Policies**: Restrict agent access dynamically using declarative YAML.
- **Provider Routing**: Built-in support for OpenShell's LLM inference routing.
- **Guided Onboarding**: Easy setup through Claude Code skills.

## Setup

1. Make sure you have the `openshell` CLI installed and configured on your host.
2. In the NanoClaw directory, open the `claude` CLI and run the `/setup-openshell` skill:
   ```bash
   claude
   > /setup-openshell
   ```
3. Claude will configure your `.env` file to use the OpenShell backend.

## Configuration

When using OpenShell, the following environment variables control its behavior (typically configured in `.env`):

- `RUNTIME_ENGINE=openshell`: Instructs NanoClaw to use the OpenShell runner instead of Docker.
- `OPENSHELL_POLICY`: The path to the OpenShell policy file used to constrain the agent's sandbox.
- `OPENSHELL_PROVIDERS`: (Optional) The providers list for inference routing.
- `OPENSHELL_AUTO_PROVIDERS`: (Optional) Enable automatic provider selection.

## How it works

Unlike the Docker backend which uses live volume mounts (`-v`), the OpenShell backend manages synchronization via the `openshell sandbox upload` and `download` commands:

1. **Create & Upload**: A new sandbox is created for the agent run. The workspace files (group configs, memory, etc.) are uploaded into the sandbox.
2. **Execute & Mid-flight Sync**: The agent runs inside the OpenShell sandbox. For state updates (e.g. tasks or group configurations), NanoClaw seamlessly syncs changes into the active sandbox.
3. **Download & Teardown**: Once the execution finishes, the modified files are downloaded back to the host, and the sandbox is destroyed to clean up resources.
