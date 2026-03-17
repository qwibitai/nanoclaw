# OpenShell Runtime Setup

Sets up the NVIDIA OpenShell runtime and gateway for NanoClaw.

## Features

- Provisions the OpenShell gateway
- Connects NVIDIA API tokens
- Provides instructions to update the `.env` file

## Usage

Use this skill when the user asks to "setup openshell", "use openshell instead of docker", "connect nvidia openshell", etc.

### Step 1: Tell the user what you are doing

Send a friendly message that you will help them set up OpenShell and the NVIDIA Cloud Inference routing.

### Step 2: Deploy Gateway

Run `openshell gateway start`. It might prompt or just run. Check if it's already running via `openshell gateway status`.

```bash
openshell gateway status || openshell gateway start
```

### Step 3: Auto-Providers

NemoClaw usually connects to NVIDIA endpoints. You can ask the user if they have an `NGC_API_KEY` or want to login to NGC.
If they do, they can add it to their system. Explain they can run `openshell provider add nvidia`.

### Step 4: Configure NanoClaw

Instruct the user to add the following lines to their `.env` file:

```
RUNTIME_ENGINE=openshell
OPENSHELL_AUTO_PROVIDERS=true
```

Optionally:

```
OPENSHELL_PROVIDERS=nvidia
```

### Step 5: Restart

Tell the user to restart NanoClaw for the changes to take effect.
