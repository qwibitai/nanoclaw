# Lessons

- 2026-05-01: When a deployed child runner says a provider key is missing, verify the service variables before assuming Railway misconfiguration. In Baget single-process mode, child processes inherit only an explicit env allowlist, so provider registry imports and env passthrough are the first code paths to check.
- 2026-05-01: When a non-Claude provider ignores the Baget persona and answers as the underlying model, verify the actual provider system instruction path instead of assuming `CLAUDE.local.md` is auto-loaded. In this fork, Gemini needs the rendered workspace prompt bundle injected explicitly, and Baget founder groups should not set `assistantName` to the company name.
