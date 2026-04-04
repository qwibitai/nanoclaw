# Tasks

## Task 1: DB 持久化层
**File:** `src/db.ts`
**Requirements:** R1.1, R1.2, R1.4

新增 `account_rotate_config` 表和读写函数：

```typescript
// 建表（在 initDb 中）
CREATE TABLE IF NOT EXISTS account_rotate_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

// 新增函数
export function getRotateEnabled(): boolean;
export function setRotateEnabled(enabled: boolean): void;
export function getRotateIndex(): number;
export function setRotateIndex(index: number): void;
export function getLastRotateAt(): number | null;
export function setLastRotateAt(ts: number): void;
```

## Task 2: 429 检测函数
**File:** `src/container-runner.ts`
**Requirements:** R2.1, R2.2

```typescript
// 在文件中新增
export function detectRateLimit(text: string): boolean {
  const patterns = [
    /429/i,
    /rate.?limit/i,
    /overloaded/i,
    /quota.?exceeded/i,
    /too.?many.?requests/i,
  ];
  return patterns.some(p => p.test(text));
}
```

在容器 stdout/stderr 处理中调用此函数。

## Task 3: 轮换核心逻辑
**File:** `src/container-runner.ts`
**Requirements:** R3.1-R3.6, R4.1-R4.3, R5.1-R5.2

```typescript
export async function rotateAccount(agentId: string): Promise<{
  success: boolean;
  newSecretName: string;
} | null> {
  // 1. 检查 autoRotateEnabled
  // 2. 检查 debounce（60s）
  // 3. onecli secrets list → 获取所有 secrets
  // 4. currentIndex + 1 → 下一个
  // 5. 检查是否轮换一圈（全部耗尽）
  // 6. onecli agents set-secrets → 切换
  // 7. 更新 DB（index, lastRotateAt）
  // 8. 返回结果
}
```

## Task 4: runAgent 集成轮换 + 重试
**File:** `src/index.ts`
**Requirements:** R3.4, R3.5, R3.6

在 `runAgent` 返回 error 时：
1. 检查容器输出是否包含 429
2. 如果是且 autoRotate 开启 → 调用 rotateAccount()
3. 成功轮换后 → 清除 session + 重试 runAgent（最多重试 1 次）
4. 向用户发送轮换通知

## Task 5: `/account auto` 指令
**File:** `src/index.ts`
**Requirements:** R1.1, R1.2, R1.3

在已有的 `/account` 指令处理中：
- 匹配 `/account auto on` → setRotateEnabled(true) + 回复
- 匹配 `/account auto off` → setRotateEnabled(false) + 回复
- `/account` 列表中追加显示轮换状态

## Task 6: 测试
**File:** `src/memory/memory.test.ts` 或新建 `src/account-rotate.test.ts`

- 测试 detectRateLimit 对各种错误格式的匹配
- 测试 rotateAccount 的轮换逻辑（mock onecli CLI）
- 测试全部耗尽检测
- 测试 debounce 60s

## 执行顺序
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

全部完成后：`npm run build && npm run test` 必须通过。
