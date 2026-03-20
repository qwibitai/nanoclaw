# 钉钉接入说明

本文档说明本仓库中新增的钉钉渠道实现，包括：

- 功能范围
- 配置与使用方法
- 代码实现方式
- 为什么要保持模块化，方便后续给上游 `nanoclaw` 提 PR

英文版见 `docs/DINGTALK.md`。

---

## 1. 概述

当前钉钉接入采用的是：

- 钉钉应用机器人
- Stream Mode
- 群里 `@机器人` 触发

当前工作流是：

1. 用户在钉钉群中 `@` 机器人
2. NanoClaw 通过钉钉 Stream 客户端收到消息
3. 渠道层把消息转换成 NanoClaw 已有的触发格式
4. NanoClaw 正常执行 agent
5. NanoClaw 把结果回复回同一个钉钉会话

这不是个人微信式接入，而是官方钉钉机器人接入。

---

## 2. 功能范围

### 当前已支持

- 通过 Stream Mode 连接钉钉应用机器人
- 接收群里 `@机器人` 的消息
- 接收机器人私聊消息
- 发送文本回复到同一会话
- 通过 `/chatid` 返回 NanoClaw 注册所需的 JID
- 对部分非文本消息使用占位符转发

### 当前版本暂不支持

- 长时间延迟后的稳定主动消息发送
- 富交互卡片回复
- 输入中状态提示
- 完整的文件下载、上传处理
- 超出钉钉默认会话回复路径之外的复杂线程式路由

---

## 3. 文件结构

这套实现分成两层。

### A. 模块化 skill 包

这部分是未来更适合向上游提交的内容：

- `.claude/skills/add-dingtalk/SKILL.md`
- `.claude/skills/add-dingtalk/manifest.yaml`
- `.claude/skills/add-dingtalk/add/src/channels/dingtalk.ts`
- `.claude/skills/add-dingtalk/add/src/channels/dingtalk.test.ts`
- `.claude/skills/add-dingtalk/modify/src/channels/index.ts`
- `.claude/skills/add-dingtalk/modify/setup/verify.ts`
- `.claude/skills/add-dingtalk/tests/dingtalk.test.ts`

### B. 已应用到当前 fork 的运行态改动

这部分是为了让你的 fork 现在就能直接运行钉钉功能：

- `src/channels/dingtalk.ts`
- `src/channels/dingtalk.test.ts`
- `src/channels/index.ts`
- `setup/verify.ts`
- `package.json`
- `package-lock.json`
- `.env.example`

如果以后要给上游 `nanoclaw` 提 PR，建议优先提交 `.claude/skills/add-dingtalk/` 这一整套 skill 包，而不是已经应用到 fork 上的运行态结果文件。

---

## 4. 运行时架构

该渠道遵循 NanoClaw 现有的 channel 抽象：

1. `src/channels/dingtalk.ts` 通过 `registerChannel('dingtalk', ...)` 自注册
2. `src/channels/index.ts` 通过 `import './dingtalk.js'` 把模块接入启动流程
3. NanoClaw 启动时加载 channel registry
4. 如果检测到 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`，就实例化钉钉渠道
5. 钉钉 Stream 客户端开始监听机器人事件
6. 每个入站事件被转换成 NanoClaw 的 `NewMessage`
7. 后续消息队列、路由、容器执行逻辑保持不变

这也是为什么这次改动可以保持较小体量：钉钉代码只负责把钉钉事件桥接进 NanoClaw 既有消息管线。

---

## 5. 消息流

### 入站流程

1. 钉钉通过 Stream Mode 推送机器人事件。
2. `DingTalkChannel.handleRobotMessage()` 解析 payload。
3. 渠道层把 NanoClaw 的会话 JID 计算为：

```text
ding:<conversationId>
```

4. 通过 `onChatMetadata(...)` 上报聊天元数据。
5. 如果消息命中了钉钉的 `@机器人` 列表，就把内容改写为 NanoClaw 标准触发形式：

```text
@<ASSISTANT_NAME> ...
```

6. 通过 `onMessage(...)` 把消息交给 NanoClaw。
7. 后续就走 NanoClaw 既有的消息队列、路由、容器和出站逻辑。

### 出站流程

1. NanoClaw 需要回复时，会调用 `sendMessage(jid, text)`。
2. 钉钉渠道从最近一次入站消息里缓存的 `sessionWebhook` 查找回复地址。
3. 通过该 webhook 向钉钉发送文本消息。

这种做法的好处是实现很轻，且不需要改 NanoClaw 整个出站管线。

---

## 6. 为什么使用 `sessionWebhook`

钉钉机器人入站 payload 会携带一个当前会话可用的回复 webhook。

当前实现会缓存：

- `sessionWebhook`
- `sessionWebhookExpiredTime`

因此，在用户刚发来一条消息之后，NanoClaw 可以很自然地往同一个会话回消息。

这也是当前版本的核心取舍：

- 对“请求-响应式聊天”很适合
- 对“延迟很久之后再主动发消息”较弱

如果 NanoClaw 在缓存过期后还想往这个钉钉会话发消息，就会失败，直到这个会话再次收到新的入站消息，把 session 信息刷新。

---

## 7. 配置

在 `.env` 中添加：

```bash
DINGTALK_CLIENT_ID=你的_client_id
DINGTALK_CLIENT_SECRET=你的_client_secret
```

然后同步运行时环境：

```bash
mkdir -p data/env
cp .env data/env/env
```

注意：

- 服务和部分运行时逻辑读取的是 `data/env/env`
- `setup/verify.ts` 只有在这两个变量都存在时，才会把钉钉标记为已配置

---

## 8. 钉钉应用侧配置

你需要先创建一个启用了 Stream Mode 的钉钉应用机器人。

推荐检查项：

1. 创建一个钉钉企业内部应用或机器人应用
2. 开启机器人消息能力
3. 开启 Stream Mode
4. 拿到应用的 `Client ID` 和 `Client Secret`
5. 把机器人拉进目标钉钉群

当前实现假设钉钉平台会向机器人提供：

- 群里 `@机器人` 的消息
- 发给机器人的私聊消息

---

## 9. 构建与重启

更新凭据后执行：

```bash
npm run build
```

macOS：

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux：

```bash
systemctl --user restart nanoclaw
```

本地开发也可以直接：

```bash
npm run dev
```

---

## 10. 获取钉钉会话 ID

在钉钉会话里 `@` 机器人并发送：

```text
/chatid
```

机器人会回复：

```text
Chat ID: ding:cidXXXXXXXXXXXXXXXX
Type: group
```

这里的 `ding:...` 就是 NanoClaw 注册该会话时要使用的 JID。

---

## 11. 注册钉钉会话

NanoClaw 已有 `setup register` 这条 CLI 路径，可以直接注册钉钉会话：

```bash
npx tsx setup/index.ts --step register -- \
  --jid ding:cidXXXXXXXXXXXXXXXX \
  --name "DingTalk Engineering" \
  --trigger "@Andy" \
  --folder dingtalk_engineering \
  --channel dingtalk
```

如果要注册成主会话：

```bash
npx tsx setup/index.ts --step register -- \
  --jid ding:cidXXXXXXXXXXXXXXXX \
  --name "DingTalk Main" \
  --trigger "@Andy" \
  --folder dingtalk_main \
  --channel dingtalk \
  --no-trigger-required \
  --is-main
```

说明：

- JID 格式必须是 `ding:<conversation-id>`
- `--channel dingtalk` 建议明确传入
- `--no-trigger-required` 一般只建议给主控制会话或私聊会话使用

---

## 12. 使用方法

### 群聊

在钉钉群里：

```text
@机器人 总结一下今天的讨论
```

渠道层会把这个 `@机器人` 改写为 NanoClaw 内部的标准触发格式，因此原有路由逻辑无需改动。

### 私聊

在私聊里也可以走同一套 channel。是否“所有消息都处理”取决于你注册该会话时的 `requiresTrigger` 配置。

### `/chatid`

任何时候如果要确认会话对应的 NanoClaw JID，都可以发送 `/chatid`。

---

## 13. 非文本消息

当前版本是“文本优先”设计。

部分非文本消息会被转成占位符，例如：

- `[File: plan.pdf]`
- `[Image]`
- `[Audio]`
- `[Video]`

这样 agent 至少知道“用户发过一个东西”，但暂时还没有实现完整媒体拉取和处理。

---

## 14. 验证命令

本次钉钉接入使用了以下针对性验证命令：

```bash
npm run build
npx vitest run src/channels/dingtalk.test.ts
npx vitest run --config vitest.skills.config.ts .claude/skills/add-dingtalk/tests/dingtalk.test.ts
```

它们分别验证：

- 已应用到 fork 的运行态代码
- 钉钉渠道本身
- 模块化 skill 包本身

---

## 15. 排查问题

### 机器人连不上

检查：

- `DINGTALK_CLIENT_ID` 是否存在
- `DINGTALK_CLIENT_SECRET` 是否存在
- `.env` 是否已经同步到 `data/env/env`
- 修改后是否已经重启服务

### 机器人已连接，但群里不回复

检查：

- 机器人是否已加入该钉钉群
- 发送的消息是否真的 `@` 了机器人
- 该钉钉会话是否已经注册进 NanoClaw
- 注册用的 JID 是否严格等于 `ding:<conversation-id>`

### `/chatid` 不回复

检查：

- 机器人是否真的收到了 Stream 事件
- 该群是否允许机器人工作
- 查看运行日志：

```bash
tail -f logs/nanoclaw.log
```

### 出站回复失败

最常见的原因是缓存的 `sessionWebhook` 不存在或已过期。此时只要在同一个钉钉会话里再发一条新的入站消息，session 信息就会刷新。

---

## 16. 已知限制

### 长延迟主动消息能力较弱

这是当前版本最主要的限制。

因为出站回复目前依赖最近一次入站消息里缓存的 `sessionWebhook`，所以计划任务或很久之后的跟进消息，可能会因为 session 已过期而失败。

### 没有 typing 状态

当前接入路径下没有可用的钉钉 typing 能力，所以 `setTyping()` 是空实现。

### 文本优先

富卡片、上传、完整媒体处理目前都没有做，属于后续增强项。

### 群聊使用方式是 `@` 驱动

当前设计目标就是群里 `@机器人` 触发，不是无差别监听群内所有消息。

---

## 17. 上游 PR 建议

如果未来要把这套能力贡献回 `nanoclaw`，建议保持模块化。

更适合作为上游 PR 的内容是：

- `.claude/skills/add-dingtalk/SKILL.md`
- `.claude/skills/add-dingtalk/manifest.yaml`
- `.claude/skills/add-dingtalk/add/...`
- `.claude/skills/add-dingtalk/modify/...`
- `.claude/skills/add-dingtalk/tests/...`

除非上游明确要求把运行态文件直接提交进 core，否则不建议把已经应用到 fork 上的结果文件一并塞进上游 PR。

可以简单理解为：

- 给上游提 PR：提交 skill 包
- 在你自己的 fork 上运行：保留已应用后的 channel 文件

这样最符合 NanoClaw 当前“skills over features”的架构方向。
