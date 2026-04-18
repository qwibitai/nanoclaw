# NanoClaw 核心流程单元测试补全

## 背景

NanoClaw 41% 的源文件有测试，但存在两个致命盲区：
1. **`index.ts`**（1462 行，主消息循环）完全无测试
2. **`progress-server.ts`**（326 行，进度卡片 HTTP 服务）完全无测试
3. 已有测试的核心文件（`container-runner.ts`、`feishu.ts`）缺少关键边界条件

## 目标

补全核心流程的单元测试，覆盖以下优先级：

- **P0**：`index.ts` 可导出函数 + 提取纯函数
- **P0**：`container-runner.ts` 缺失边界条件
- **P1**：`progress-server.ts` 核心 CRUD
- **P1**：`feishu.ts` 缺失边界条件

## 范围

### 不在范围内

- 不修改业务代码逻辑（除非为提取可测试纯函数做最小重构）
- 不写集成测试 / E2E 测试
- 不改 CI/CD 配置

---

## Phase 1：index.ts 可测试单元

### 1.1 现有 export 函数（直接可测）

| 函数 | 测试场景 |
|------|---------|
| `getAvailableGroups()` | 过滤 `__group_sync__`；`is_group` 验证；按 `lastActivity` 排序；空输入 |
| `_setRegisteredGroups()` | 设置后 `getAvailableGroups` 可查；覆盖写入 |

### 1.2 需提取为纯函数的逻辑

| 提取函数 | 原位置 | 测试场景 |
|---------|--------|---------|
| `parseModelPrefix(text)` | 行 327-359 | `!! msg` → Sonnet adaptive；`! msg` → Sonnet disabled；`+ msg` → Opus adaptive；`~ msg` → disabled；全角 `！` `！！`；无前缀 → null；空字符串；只有前缀无内容 |
| `matchesTrigger(text, trigger)` | 行 316-324, 1044-1053 | 正则 trigger 匹配；大小写；空 trigger（注：需解耦 `getTriggerPattern` 依赖，通过参数注入 pattern） |

### 1.3 测试用例清单（index.test.ts，预计 15-20 个用例）

```
describe('getAvailableGroups')
  ✓ 过滤 __group_sync__ 键
  ✓ 只返回 is_group 为 true 的群
  ✓ 按 lastActivity 降序排列
  ✓ 空对象返回空数组
  ✓ lastActivity 缺失时排在末尾

describe('parseModelPrefix')
  ✓ "!! msg" → { model: 'claude-sonnet-4-6', thinking: 'adaptive' }（Sonnet 深度思考）
  ✓ "! msg" → { model: 'claude-sonnet-4-6', thinking: 'disabled' }（Sonnet 快速）
  ✓ "+ msg" → { model: 'claude-opus-4-6', thinking: 'adaptive' }（Opus 深度思考）
  ✓ "~ msg" → { thinking: 'disabled' }（关闭思考）
  ✓ "！！ msg"（全角）→ 同 "!!"
  ✓ "！ msg"（全角）→ 同 "!"
  ✓ 无前缀 → null
  ✓ 空字符串 → null
  ✓ 只有前缀没有内容（如 "! "）→ 返回 override + 空内容
  ✓ 前缀后无空格（如 "!msg"）→ null（不触发）

describe('matchesTrigger')
  ✓ 正则 trigger 匹配成功
  ✓ 正则 trigger 不匹配
  ✓ 空 trigger 总是匹配
```

---

## Phase 2：container-runner.ts 边界增强

在现有 `container-runner.test.ts` 中新增：

```
describe('输出截断')
  ✓ stdout 超 10MB 时截断不崩溃
  ✓ 截断后仍能解析最后一个完整 output marker

describe('解析边界')
  ✓ output marker 分两个 chunk 到达（跨 chunk 拼接）
  ✓ JSON 畸形时 warn 但不中断 chain
  ✓ 缺少 OUTPUT_END_MARKER 时等待后续 chunk

describe('detectRateLimit')
  ✓ "You've hit your rate limit" → true
  ✓ "429 Too Many Requests" → true
  ✓ "hit your limit" → true
  ✓ 正常文本 → false
  ✓ 空字符串 → false
  ✓ "error 4290" → false（不应误匹配）
  ✓ 大小写混合 "Hit Your Limit" → true

describe('buildLocalEnv')
  ✓ 正确注入 HTTPS_PROXY
  ✓ NO_PROXY 包含飞书域名
  ✓ 无 OneCLI 配置时使用 fallback
```

预计 12-15 个用例。

---

## Phase 3：progress-server.ts

新建 `progress-server.test.ts`：

```
describe('session CRUD')
  ✓ upsertSession 创建新 session
  ✓ upsertSession 更新已有 session
  ✓ completeSession 标记完成
  ✓ deleteSession 删除内存和 DB
  ✓ 不存在的 session 操作不抛异常

describe('getProgressUrl')
  ✓ 格式正确：http://{ip}:{port}/p/{id}
  ✓ 端口从配置读取

describe('HTTP 路由')
  ✓ GET /p/{validId} → 200 HTML
  ✓ GET /p/{validId}?json=1 → 200 JSON
  ✓ GET /p/{invalidId} → 404
  ✓ GET /unknown-path → 404
```

预计 10-12 个用例。

---

## Phase 4：feishu.ts 边界增强

在现有 `feishu.test.ts` 中新增：

```
describe('sendPlainOrCard 降级')
  ✓ 卡片发送失败 → 自动降级纯文本（create 被调用两次）
  ✓ 降级后纯文本也失败 → reject 自然传播（验证 promise rejects）

describe('extractAndSendMedia')
  ✓ 含 [图片: /path] 标记 → 提取路径并发送
  ✓ 含 [文件: /path] 标记 → 提取路径并发送
  ✓ 无标记 → 直接发文本
  ✓ groupFolder 为 null → 原文本直接发

describe('typing indicator')
  ✓ setTyping(true) 添加 emoji reaction
  ✓ setTyping(false) 移除 emoji reaction
  ✓ 并发 removeTypingReaction 幂等

describe('进度消息聚合')
  ✓ progressDone 后忽略迟到的进度消息
  ✓ 💭 消息单独发送不加入卡片
```

预计 12-15 个用例。

---

## 实施策略

### 最小重构原则

从 `index.ts` 提取纯函数并 `export`，不改变现有行为：
- `parseModelPrefix(text)` — 无副作用，直接提取（低风险）
- `matchesTrigger(text, pattern)` — 需将 `getTriggerPattern` 结果作为参数注入，解耦 config 依赖（中等复杂度）

### 文件变更清单

| 操作 | 文件 |
|------|------|
| 新建 | `src/index.test.ts` |
| 新建 | `src/progress-server.test.ts` |
| 修改 | `src/container-runner.test.ts`（新增用例） |
| 修改 | `src/channels/feishu.test.ts`（新增用例） |
| 修改 | `src/index.ts`（提取 2-3 个纯函数，export） |

### 验收标准

1. `npx vitest run` 全部通过
2. 新增 ≥ 50 个测试用例
3. 覆盖所有列出的场景
4. 不改变任何现有业务行为
