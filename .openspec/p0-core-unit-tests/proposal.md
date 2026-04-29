# P0 核心模块单元测试补全

## 背景

Phase 1-4 已补全 53 个测试（index.ts、container-runner.ts、progress-server.ts、feishu.ts）。
剩余 5 个 P0 文件零测试覆盖，均为核心运行时模块：

| 文件 | 行数 | 职责 | 风险 |
|------|------|------|------|
| `router.ts` | 60 | XML 转义 + 消息格式化 + 路由 | 低（纯函数为主） |
| `channels/feishu-oauth.ts` | 417 | OAuth 令牌获取/刷新/缓存 | 高（涉及外部 API） |
| `memory/storage.ts` | 525 | 记忆 SQLite 存储层 | 高（FTS + embedding 去重） |
| `memory/inject.ts` | 605 | 记忆注入 CLAUDE.md + 双路召回 | 高（BM25 + Qdrant） |
| `ipc.ts` | 776 | 文件 IPC 系统 + 11 种任务 | 高（权限 + 多种分支） |

## 目标

为 5 个 P0 文件补全单元测试，目标 **80+ 个测试用例**，优先覆盖核心逻辑和安全边界。

## 范围

### 在范围内
- 可测试的纯函数和可 mock 的业务逻辑
- 权限/授权检查的边界条件
- 数据完整性（去重、缓存 TTL、原子写入）

### 不在范围内
- 真实网络请求（全部 mock fetch/Qdrant）
- HTTP server 端口监听（只测逻辑，不起 server）
- 修改业务代码逻辑

---

## Phase 5：router.ts（~12 用例）

最简单的文件，纯函数为主，快速收割。

```
describe('escapeXml')
  ✓ 转义 & < > " 四种字符
  ✓ 空字符串 → 空字符串
  ✓ null/undefined → 空字符串（falsy guard）
  ✓ 无需转义的文本 → 原样返回

describe('formatMessages')
  ✓ 单条消息格式正确（含 sender、time、content）
  ✓ 多条消息换行拼接
  ✓ 带 reply_to 属性 → 含 reply_to="" 和 quoted_message
  ✓ content 中的 XML 特殊字符被转义
  ✓ 空消息数组 → 只有 header

describe('stripInternalTags')
  ✓ 移除 <internal>...</internal> 标签
  ✓ 多个 internal 标签全部移除
  ✓ 无标签 → 原样返回

describe('formatOutbound')
  ✓ 移除 internal 标签后返回
  ✓ 全是 internal → 返回空字符串

describe('routeOutbound')
  ✓ 匹配到 channel → 调用 sendMessage
  ✓ 无匹配 channel → 抛出 Error

describe('findChannel')
  ✓ 匹配 → 返回 channel
  ✓ 无匹配 → 返回 undefined
```

---

## Phase 6：channels/feishu-oauth.ts（~15 用例）

重点测 token 缓存逻辑和 state 解析，mock 掉 fetch 和 DB。

**Mock 策略**：
- `fetch` → vi.fn() 控制 HTTP 响应
- `../db.js` → mock getFeishuTokenByUserId / setFeishuToken / getAllFeishuTokenUsers
- `../env.js` → mock readEnvFile 返回 APP_ID/SECRET

```
describe('getFeishuUserToken')
  ✓ 内存缓存命中（未过期）→ 直接返回 token
  ✓ 内存缓存过期 → 查 DB
  ✓ DB token 未过期 → 返回 token + 写入缓存
  ✓ DB token 需刷新 → 调用 refresh API
  ✓ refresh 并发去重（两次调用只触发一次 fetch）
  ✓ DB 无记录 → 返回 null
  ✓ refresh 失败 → 返回 null

describe('buildAuthUrl')
  ✓ 包含 app_id、redirect_uri、scope、state
  ✓ state 被 encodeURIComponent
  ✓ 无 app credentials → 返回空字符串

describe('startOAuthCallbackServer - state 解析')
  ✓ state "fs:oc_xxx|folder_name" → chatJid=fs:oc_xxx, groupFolder=folder_name
  ✓ state 无 | → chatJid=整个 state, groupFolder=''
  ✓ code 缺失 → 400
  ✓ token 换取失败 → 500
  ✓ token 换取成功 → 200 + onToken 回调
```

---

## Phase 7：memory/storage.ts（~20 用例）

用真实 SQLite（:memory: 或 tmpdir），不 mock DB。

**测试策略**：每个 test 用 `closeMemoryDb()` 清理，或用独立 tmpdir。

```
describe('Profile CRUD')
  ✓ saveProfile + loadProfile 往返一致
  ✓ 覆盖写入（同 group+user）→ 取最新
  ✓ 空表 → loadProfile 返回 null
  ✓ 无效 JSON → loadProfile 返回 null

describe('Facts CRUD')
  ✓ storeFactRaw → loadFacts 包含新 fact
  ✓ storeFactRaw 同 id 重复 → INSERT OR IGNORE
  ✓ removeFacts → loadFacts 不含已删 fact
  ✓ removeFacts 空数组 → 返回 0
  ✓ updateFact 更新 content → loadFacts 反映
  ✓ updateFact 不存在的 id → 返回 false

describe('storeFacts 去重')
  ✓ 字符串精确重复 → 跳过（storedCount < 输入数）
  ✓ 向量语义重复（cosine > 0.95）→ 跳过
  ✓ 空 content → 跳过

describe('Facts 缓存')
  ✓ loadFacts 连续调用 → 第二次走缓存（不重新查 DB）
  ✓ invalidateFactsCache 后 → 重新查 DB

describe('enforceMaxFacts')
  ✓ facts 数量 ≤ limit → 不删除
  ✓ facts 数量 > limit → 按加权分数保留 top-N
  ✓ 近 7 天 fact 有 +0.1 recency bonus

describe('FTS')
  ✓ storeFactRaw 后 FTS 索引同步
  ✓ backfillFtsIndex 补录缺失的 FTS 条目
```

---

## Phase 8：memory/inject.ts（~18 用例）

核心是 extractKeywords 和 BM25 评分（纯函数），外加 CLAUDE.md 注入逻辑。

**Mock 策略**：
- `./embeddings.js` → mock getEmbedding 返回固定向量
- `@qdrant/js-client-rest` → mock QdrantClient
- `./storage.js` → mock loadFacts / loadProfile
- `./memory-store.js` → mock MemoryStore.getInstance().recall
- `fs` → mock existsSync / readFileSync / writeFileSync

```
describe('extractKeywords')
  ✓ 英文提取 3+ 字符单词
  ✓ 中文 bigram 滑窗（"动态记忆" → ["动态", "态记", "记忆"]）
  ✓ 短中文词（≤4 字）整体保留
  ✓ 混合中英文
  ✓ 空字符串 → 空数组
  ✓ 结果去重

describe('bm25Score')
  ✓ query 命中 → 正分数
  ✓ query 不命中 → 0 分
  ✓ 空 docs → 空数组

describe('hashContext / context hash')
  ✓ 相同 context → 相同 hash
  ✓ 不同 context → 不同 hash
  ✓ set/get/clear context hash 正确

describe('matchWikiEntries')
  ✓ 关键词命中 wiki index → 返回匹配
  ✓ 无命中 → 返回空数组
  ✓ wiki index 不存在 → 返回空数组

describe('injectMemory')
  ✓ 首次注入 → CLAUDE.md 中包含 memory start/end 标记
  ✓ 重复注入 → 替换已有 memory section（不重复追加）
  ✓ 无记忆数据 → 不写文件
  ✓ injectionEnabled=false → 不写文件
```

---

## Phase 9：ipc.ts（~20 用例）

重点测 processTaskIpc 的 11 种任务类型和权限检查。

**Mock 策略**：
- `fs` → mock 文件读写（或用 tmpdir 真实文件）
- `./db.js` → mock createTask / updateTask / deleteTask / getTaskById
- `./memory/*` → mock 记忆相关依赖
- `IpcDeps` → 用 vi.fn() 构造完整 deps 对象

```
describe('writeIpcResponse')
  ✓ 原子写入：先写 .tmp 再 rename
  ✓ 目录不存在时自动创建

describe('processTaskIpc - schedule_task')
  ✓ cron 类型 → 创建任务 + 计算 nextRun
  ✓ interval 类型 → nextRun = now + ms
  ✓ once 类型 → nextRun = 指定时间
  ✓ 无效 cron 表达式 → 不创建
  ✓ 非 main group 跨组调度 → 被阻止

describe('processTaskIpc - pause/resume/cancel')
  ✓ pause → 更新 status='paused'
  ✓ resume → 更新 status='active'
  ✓ cancel → 删除任务
  ✓ 非 main group 操作其他组任务 → 被阻止

describe('processTaskIpc - update_task')
  ✓ 更新 prompt → DB 反映
  ✓ 更新 schedule → 重新计算 nextRun
  ✓ 任务不存在 → warn

describe('processTaskIpc - register_group')
  ✓ main group → 成功注册
  ✓ 非 main group → 被阻止
  ✓ 不安全的 folder name → 被阻止
  ✓ 缺少必填字段 → warn

describe('processTaskIpc - memory_recall')
  ✓ 有 query → 走 MemoryStore.recall
  ✓ 无 query → 返回全量 facts
  ✓ memory 未启用 → 返回 error

describe('processTaskIpc - rename_chat')
  ✓ main group → 允许重命名任意群
  ✓ 非 main group 重命名自己的群 → 允许
  ✓ 非 main group 重命名别人的群 → 被阻止
```

---

## 实施顺序

1. **router.ts** → 最简单，5 分钟搞定
2. **feishu-oauth.ts** → 中等复杂度
3. **memory/storage.ts** → 真实 SQLite 测试
4. **memory/inject.ts** → 纯函数 + mock
5. **ipc.ts** → 最复杂，权限矩阵

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 新建 | `src/routing.test.ts`（router.ts 测试） |
| 新建 | `src/channels/feishu-oauth.test.ts` |
| 新建 | `src/memory/storage.test.ts` |
| 新建 | `src/memory/inject.test.ts` |
| 新建 | `src/ipc.test.ts` |

注：不修改任何业务代码。routing.test.ts 已存在则追加。

## 验收标准

1. `npx vitest run` 全部通过（含已有 451 个 + 新增 ~85 个）
2. 覆盖所有列出的场景
3. 不改变任何现有业务行为
4. mock 隔离充分，不依赖外部网络/服务
