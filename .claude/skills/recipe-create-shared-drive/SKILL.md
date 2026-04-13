---
name: recipe-create-shared-drive
description: "Create a Google Shared Drive and add members with appropriate roles."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "productivity"
    requires:
      bins:
        - gws
      skills:
        - gws-drive
---

# Create and Configure a Shared Drive

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-drive`

Create a Google Shared Drive and add members with appropriate roles.

## Steps

1. Create shared drive: `gws drive drives create --params '{"requestId": "unique-id-123"}' --json '{"name": "Project X"}'`
2. Add a member: `gws drive permissions create --params '{"fileId": "DRIVE_ID", "supportsAllDrives": true}' --json '{"role": "writer", "type": "user", "emailAddress": "member@company.com"}'`
3. List members: `gws drive permissions list --params '{"fileId": "DRIVE_ID", "supportsAllDrives": true}'`

