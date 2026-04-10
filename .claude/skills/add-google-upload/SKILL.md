---
name: add-google-upload
description: Add or maintain Google upload support in this NanoClaw fork by wiring Google OAuth environment variables, checking for an existing Google integration, and implementing document upload flows when the user wants to upload files to Google services.
---

# Add Google Upload

Use this skill when the user wants Google document upload support added to this NanoClaw fork.

## What This Skill Enables

- Wires Google OAuth configuration from `.env`
- Audits the repo for existing Google or Drive integration points
- Implements upload support for the chosen Google target, such as Drive or Docs
- Verifies the configured client ID key is `GOOGLE_CLIENT_ID`

## Required Environment

The local `.env` should contain at least:

```env
GOOGLE_CLIENT_ID=your_google_oauth_client_id
```

Additional keys may be required depending on the final implementation, such as:

- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_PROJECT_ID`

## Workflow

1. Inspect the repo for any existing Google-related code before making changes.
2. Clarify whether the upload target is Google Drive, Google Docs, or Google Cloud Storage.
3. Reuse the existing env/config pattern instead of scattering OAuth config.
4. Add the minimum viable integration and document any remaining OAuth setup.
5. Run typecheck/tests after changes.

## Constraints

- Do not hardcode OAuth secrets in source files.
- Do not say uploads are live unless the required OAuth credentials and code path both exist.
- If the user has only provided a client ID, call out the additional credentials still needed for a working upload flow.
