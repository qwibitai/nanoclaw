## Why

NanoClaw 目前支持 WhatsApp、Telegram、Slack、Discord、Gmail 五种 Channel，但不支持飞书（Feishu/Lark）。我们的团队主要使用飞书进行日常沟通，从 OpenClaw 迁移到 NanoClaw 后需要保持飞书消息收发能力。飞书在中国企业市场是主流 IM 工具，缺少飞书支持会阻断迁移。

## What Changes

- 新增 `src/channels/feishu.ts`：实现 `Channel` 接口的飞书 Channel，包含 WebSocket 长连接收消息、文本/卡片消息发送、emoji reaction typing indicator、群列表同步
- 修改 `src/channels/index.ts`：添加 `import './feishu.js'` 注册飞书 Channel
- 新增 `src/channels/feishu.test.ts`：单元测试
- 新增 `.claude/skills/add-feishu/SKILL.md`：安装指引 skill
- 修改 `package.json`：添加 `@larksuiteoapi/node-sdk` 依赖
- 修改 `.env.example`：添加 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 环境变量
- JID 命名规范：`fs:{chat_id}`（如 `fs:oc_xxx`）

## Capabilities

### New Capabilities
- `feishu-channel`: 飞书消息收发 Channel 实现，包括 WebSocket 连接管理、消息类型解析（text/post/image）、文本及交互卡片发送、emoji reaction typing indicator、群元数据同步

### Modified Capabilities
（无既有 spec 需修改）

## Impact

- **依赖**: 新增 `@larksuiteoapi/node-sdk` npm 包
- **环境变量**: 新增 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`
- **代码**: 新增 ~200-300 行 TypeScript，修改 2 个已有文件（channels/index.ts、package.json）
- **容器**: 无需修改容器镜像，飞书 SDK 只在宿主机进程中运行
- **兼容性**: 纯增量变更，不影响已有 Channel
