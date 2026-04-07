## Architecture

### 组件交互

```
用户消息 → processGroupMessages()
  → runAgent() → buildContainerArgs() → OneCLI applyContainerConfig(agent=X)
    → Docker 容器启动（注入账号 X 的 token）
      → Claude Code SDK query()
        → 429 错误 → 容器 stderr 输出错误
  → container-runner 检测 stderr 中的 429
    → rotateAccount(groupFolder)
      → onecli agents set-secrets --id <agent> --secret-ids <next-secret>
      → 清除 session
      → 重试 runAgent()（新容器用新 token）
```

### 状态管理

```typescript
// SQLite 持久化
interface RotateConfig {
  enabled: boolean;           // /account auto on|off
  currentIndex: number;       // 当前 secret 在列表中的位置
  secretIds: string[];        // 缓存的 secret ID 列表（启动时从 onecli 刷新）
  lastRotateAt: string | null; // 上次轮换时间
}
```

存储在 `store/messages.db` 的新表 `account_rotate_config`。

### 错误检测

容器 stdout/stderr 中匹配以下模式：
- `429` + `rate_limit` / `overloaded` / `too many requests`
- `quota` + `exceeded` / `exhausted`
- Claude Code SDK 的 `RateLimitError` / `OverloadedError`

### 轮换逻辑

```
检测到 429 →
  if (!autoRotateEnabled) → 正常报错，不重试
  if (autoRotateEnabled) →
    nextIndex = (currentIndex + 1) % secrets.length
    if (nextIndex === startIndex) → 全部耗尽，通知用户，停止
    else →
      onecli agents set-secrets → 切换
      清除 session
      重试 runAgent()
```

### 防抖

- 同一个 secret 的 429 在 60s 内只触发一次轮换（防止快速连续切换）
- 全部耗尽后 10 分钟内不再尝试轮换

## Data Model

```sql
CREATE TABLE IF NOT EXISTS account_rotate_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- key: 'enabled' / 'current_index' / 'last_rotate_at'
```

## API / Interface

### 用户指令

| 指令 | 行为 |
|------|------|
| `/account` | 列出账号 + 显示自动轮换状态 |
| `/account <name>` | 手动切换 |
| `/account auto on` | 开启自动轮换 |
| `/account auto off` | 关闭自动轮换 |

### 内部函数

```typescript
// container-runner.ts
function detectRateLimit(output: string): boolean;
function rotateAccount(agentId: string): Promise<{ success: boolean; newSecret: string } | null>;

// db.ts
function getRotateConfig(): RotateConfig;
function setRotateConfig(config: Partial<RotateConfig>): void;
```

## Risks

1. **OneCLI CLI 调用延迟**: execSync 阻塞主线程 ~200ms，可接受
2. **Secret 切换生效延迟**: 新容器启动才生效，当前容器的请求仍会失败
3. **全部账号同时耗尽**: 通知用户后停止轮换，等待配额恢复
4. **竞态条件**: 多个群同时触发轮换 → 用 mutex 或 debounce 串行化
