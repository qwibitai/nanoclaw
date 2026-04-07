## Context

NanoClaw 的 Channel 体系是 skill-based 自注册模式：每个 Channel 实现 `Channel` 接口，在 `src/channels/index.ts` 的 barrel import 中触发 `registerChannel()` 自注册。orchestrator（`src/index.ts`）在启动时遍历所有已注册 Channel，有凭证的就 connect，没凭证的跳过。

飞书使用 WebSocket 长连接（`@larksuiteoapi/node-sdk` 的 `WSClient`）接收消息事件，用 REST API 发送消息。这与 Telegram（polling/webhook）和 WhatsApp（Baileys WS）的模式不同但接口一致。

当前飞书 App 凭证：`cli_a91afe960938dbc0` / `3nXLkudQ9FwAi3K9GYf6JeHuAehUNoEg`（OpenClaw 使用中）。

## Goals / Non-Goals

**Goals:**
- 实现完整的 `Channel` 接口：connect、disconnect、sendMessage、isConnected、ownsJid、setTyping、syncGroups
- 支持飞书文本消息（text）和富文本消息（post）接收
- 智能发送：短文本用纯文本，长文本/Markdown 用交互卡片
- typing indicator 用 emoji reaction（收到消息加表情，处理完移除）
- 群元数据同步（拉机器人所在群列表）
- JID 规范：`fs:{chat_id}`

**Non-Goals:**
- 图片/文件消息处理（后续增量）
- 合并转发消息解析（后续增量）
- 飞书审批/日历等业务 API 集成
- 飞书 OAuth 用户认证（NanoClaw 不需要用户体系）

## Decisions

### 1. 连接方式：WebSocket vs Webhook

**选择 WebSocket**。飞书 SDK 的 `WSClient` 提供长连接，无需公网域名和证书。NanoClaw 场景是本地机器运行，webhook 需要反向代理，WebSocket 更简单。

### 2. 消息发送：纯文本 vs 卡片

**自动判断**。规则：
- 文本 ≤500 字符且不含 Markdown 特征 → `msg_type: 'text'`
- 文本 >500 字符或含 ```` ``` ````、`##`、`|...|` → `msg_type: 'interactive'`（卡片）

卡片使用飞书 Markdown 模块，支持代码高亮和表格渲染。

### 3. typing indicator：表情方案

**收到消息时加 emoji reaction（如 OnIt/🤔），处理完移除**。与 OpenClaw 行为一致。飞书 API：`im.messageReaction.create` / `im.messageReaction.delete`。

### 4. JID 格式

`fs:{chat_id}`，其中 chat_id 是飞书的 `oc_xxx`（群）或 `ou_xxx`（私聊）。`ownsJid()` 匹配 `jid.startsWith('fs:')`。

### 5. 依赖选择

`@larksuiteoapi/node-sdk`（飞书官方 Node SDK）。提供 WSClient、REST API client、事件分发器，是飞书生态的标准选择。

### 6. 凭证管理

环境变量 `FEISHU_APP_ID` + `FEISHU_APP_SECRET`，通过 `readEnvFile` 读取（与其他 Channel 一致）。factory 函数检测凭证是否存在，缺失则返回 null 跳过。

## Risks / Trade-offs

- **[飞书 WS 断连]** → WSClient 内置重连机制，但需要监控 error 事件并记录日志
- **[卡片消息格式限制]** → 飞书 Markdown 子集不完整（不支持嵌套表格等），极端情况降级为纯文本
- **[API 限流]** → 飞书 API 有 QPS 限制，高频场景需注意。NanoClaw 单进程模型天然不会高并发，风险较低
- **[SDK 版本兼容]** → `@larksuiteoapi/node-sdk` 大版本升级可能 break API。锁版本号缓解
