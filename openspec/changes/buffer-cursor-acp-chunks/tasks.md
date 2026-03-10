## 1. Implementation

- [x] 1.1 In `cursor-runner.ts`: add `let textBuffer = ''` before the `while` loop
- [x] 1.2 In `client.sessionUpdate()`: replace `writeOutput(...)` with `textBuffer += update.content.text`
- [x] 1.3 After `connection.prompt()` resolves: flush buffer with `if (textBuffer) { writeOutput({ result: textBuffer, ... }); textBuffer = ''; }` then send completion marker
- [x] 1.4 Run `npm run build` — zero TypeScript errors

## 2. Validation

- [ ] 2.1 Send a test Zoom message — verify a single coherent reply instead of many fragments
- [ ] 2.2 Send a follow-up message — verify second reply is also a single message
