---
name: add-feishu
description: Add Feishu (Lark) as a channel using WebSocket connection.
---

# Add Feishu Channel

This skill adds Feishu support to NanoClaw. It uses the official `@larksuiteoapi/node-sdk` with WebSocket mode, which is perfect for local development as it doesn't require a public IP or webhook configuration.

---

# 飞书渠道技能使用说明（中文）

本技能用于为 NanoClaw 添加飞书（Lark）渠道支持。使用官方 `@larksuiteoapi/node-sdk` 的 WebSocket 模式，无需公网 IP 或回调地址，适合在本地开发环境中使用。

## 阶段 1：准备

### 1. 创建飞书应用
- 打开 [飞书开放平台](https://open.feishu.cn/app)
- 点击「创建企业自建应用」
- 填写应用名称与描述（例如：NanoClaw 助手）

### 2. 添加能力与权限
- 进入应用设置，点击「添加应用能力」→「机器人」→「添加」
- 进入「权限管理」，添加以下权限：
  - `im:message`（获取用户发给机器人的单聊消息）
  - `im:message.group_at_msg`（获取群组中 @ 机器人的消息）
  - `im:message:send_as_bot`（以应用身份发送消息）
- 进入「版本管理与发布」，创建版本并发布（企业自建应用通常无需审核）

### 3. 获取凭证
- 左侧点击「凭证与基础信息」
- 复制 **App ID**（通常以 `cli_` 开头）与 **App Secret**（查看后复制）

## 阶段 2：应用代码

### 1. 安装依赖
```bash
npm install @larksuiteoapi/node-sdk
```

### 2. 配置环境变量（交互式）
技能会通过交互式问答获取凭证：
- 询问用户 FEISHU_APP_ID
- 询问用户 FEISHU_APP_SECRET
- 自动写入 `.env` 文件

如果用户选择稍后配置，可手动在项目根目录的 `.env` 文件中添加：
```bash
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
```

### 3. 注册渠道（由技能自动完成）
技能会修改 `src/index.ts` 以导入并注册飞书渠道：
```typescript
import { FeishuChannel } from './channels/feishu.js';
import { FEISHU_APP_ID, FEISHU_APP_SECRET } from './config.js';
```
在运行时，如果检测到环境变量已配置，将自动初始化并连接飞书渠道。

### 4. 更新配置（由技能自动完成）
技能会修改 `src/config.ts`，导出：
```typescript
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
```

## 阶段 3：使用

- 私聊：直接与机器人进行对话
- 群聊：将机器人加入群组，使用 `@机器人名` 进行唤醒（或使用触发词 `@Andy`）

机器人会将每个用户或群组映射到独立的上下文与容器沙箱，确保数据与环境隔离。

## 常见问题

- 看不到消息回调：请确认权限已开通并已发布版本；本技能使用 WebSocket 模式，无需配置回调地址
- 无法发送消息：检查 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 是否正确，并确保机器人已加入对话
- 本地环境：确保 Node.js >= 20，且已执行 `npm install @larksuiteoapi/node-sdk`

---

## Phase 1: Preparation

### 1. Create Feishu App
1. Go to [Feishu Open Platform](https://open.feishu.cn/app).
2. Click "Create App" (创建企业自建应用).
3. Fill in the name (e.g., "NanoClaw Assistant") and description.

### 2. Configure Capabilities
1. In the app settings, go to **"Add Features" (添加应用能力)** -> **"Bot" (机器人)** -> Click "Add".
2. Go to **"Permissions" (权限管理)** and add the following permissions:
   - `im:message` (获取用户发给机器人的单聊消息)
   - `im:message.group_at_msg` (获取群组中@机器人的消息)
   - `im:message:send_as_bot` (以应用身份发送消息)
3. Go to **"Version Management & Release" (版本管理与发布)** -> Create a version -> Submit for release (Auto-approved for self-built apps).

### 3. Get Credentials
1. Go to **"Credentials & Basic Info" (凭证与基础信息)**.
2. Copy **App ID** and **App Secret**.

## Phase 2: Apply Code

### 1. Install Dependency
```bash
npm install @larksuiteoapi/node-sdk
```

### 2. Configure Environment (Interactive)
The skill will prompt for credentials interactively:
- Ask user for FEISHU_APP_ID
- Ask user for FEISHU_APP_SECRET
- Automatically write to `.env` file

If user chooses to configure later, manually add to `.env`:
```bash
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
```

### 3. Register Channel
Modify `src/index.ts` to import and register the channel.

**Import:**
```typescript
import { FeishuChannel } from './channels/feishu.js';
import { FEISHU_APP_ID, FEISHU_APP_SECRET } from './config.js';
```

**Registration (inside `main()` or init logic):**
```typescript
if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  const feishu = new FeishuChannel(FEISHU_APP_ID, FEISHU_APP_SECRET, {
    onMessage: handleMessage,
    onChatMetadata: handleChatMetadata,
    registeredGroups: () => registeredGroups,
  });
  channels.push(feishu);
  await feishu.connect();
}
```

### 4. Update Config
Modify `src/config.ts` to export the new environment variables:
```typescript
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
```

## Phase 3: Usage

Once running, you can chat with your bot in Feishu.
- **Private Chat**: Direct message the bot.
- **Group Chat**: Add the bot to a group and mention it (`@BotName`).

The bot will treat Feishu users/groups just like WhatsApp chats, creating isolated containers for each context.
