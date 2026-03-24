# NanoClaw

Personal AI assistant. Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

Agents run in isolated Docker containers. Single Node.js process with channel-based messaging (Discord).

## Dataflow

```
                          ┌──────────────────────────────────────────────┐
                          │           NanoClaw Host (Node.js)            │
                          │                                              │
  ┌──────────┐            │  ┌──────────┐      ┌────────────────────┐   │
  │ Discord  │◄──────────►│  │ Channel  │─────►│      SQLite        │   │
  │ Telegram │  messages   │  │ Registry │      │  messages | tasks  │   │
  │ Slack    │  files      │  └──────────┘      │  threads | sessions│   │
  └──────────┘             │                    └─────────┬──────────┘   │
                          │                               │              │
                          │       ┌───────────────────────┼──────────┐   │
                          │       ▼                       ▼          ▼   │
                          │  ┌────────────┐  ┌──────────────┐  ┌──────┐ │
                          │  │  Message   │  │    Task      │  │ IPC  │ │
                          │  │   Loop     │  │  Scheduler   │  │Watch │ │
                          │  │   (2s)     │  │   (60s)      │  │ (1s) │ │
                          │  └─────┬──────┘  └──────┬───────┘  └──┬───┘ │
                          │        │                │              │     │
                          │        ▼                ▼              │     │
                          │  ┌──────────────────────────┐         │     │
                          │  │      Group Queue         │         │     │
                          │  │  (concurrency control)   │         │     │
                          │  └────────────┬─────────────┘         │     │
                          └───────────────┼───────────────────────┼─────┘
                                          │                       │
                           ┌──────────────┼───────────────────────┼─────┐
                           │  Docker      │                       │     │
                           │              ▼                       │     │
                           │  ┌──────────────────────────┐       │     │
                           │  │    Agent Container       │       │     │
                           │  │   (Claude Agent SDK)     │       │     │
                           │  │                          │       │     │
                           │  │  /workspace/group  (rw)  │       │     │
                           │  │  /workspace/ipc ►queue/*.json────┘     │
                           │  │  ~/.claude       (session)│            │
                           │  │                          │             │
                           │  │  MCP: send_message       │             │
                           │  │       send_files         │             │
                           │  │       schedule_task      │             │
                           │  └──────────────────────────┘             │
                           └───────────────────────────────────────────┘

  Channel ─► SQLite ─► Message Loop ─► Container ─► IPC queue ─► IPC Watcher ─► Channel

  Thread isolation: data/ipc/{group}/ctx-{id}/queue/*.json
```

## Quick Reference

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
systemctl restart nanoclaw  # Restart service
```

See [CLAUDE.md](CLAUDE.md) for architecture and development details.
