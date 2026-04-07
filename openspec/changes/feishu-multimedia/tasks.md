# Tasks

## 参考实现

Nine adapter.py 有完整的 Python 实现（`~/AI_Workspace/nine/server/backend/app/feishu/adapter.py`），
需要翻译成 TypeScript 并适配 NanoClaw 的飞书 Channel 架构。

## Task 1: 图片下载工具函数
**File:** `src/channels/feishu.ts`
**Requirements:** R1.2, R1.3, R1.4, R1.6

新增 `downloadImage` 方法：
- 用 `this.client` 或直接 `fetch` 调飞书 API 下载图片
- 需要 tenant_access_token（从 `this.appId` / `this.appSecret` 获取，或复用 lark SDK 的 token）
- 保存到 `groups/{folder}/images/` 目录
- 返回容器内可见的路径 `/workspace/group/images/{filename}`
- 20MB 大小限制

```typescript
private async downloadImage(
  messageId: string, imageKey: string, groupFolder: string
): Promise<string | null>
```

## Task 2: 接收图片消息
**File:** `src/channels/feishu.ts`
**Requirements:** R1.1, R1.5

在 handleMessage 的消息类型判断中增加 `image` 分支：
```typescript
} else if (message.message_type === 'image') {
  const parsed = JSON.parse(message.content);
  const imageKey = parsed.image_key;
  if (imageKey) {
    const imgPath = await this.downloadImage(message.message_id, imageKey, groupFolder);
    text = imgPath ? `[图片: ${imgPath}]` : '[图片: 下载失败]';
  }
}
```

注意：handleMessage 当前是同步的，需要改为 async 或分离异步处理。

## Task 3: 合并转发解析
**File:** `src/channels/feishu.ts`
**Requirements:** R2.1-R2.6

参考 Nine `_parse_merge_forward`，新增：
```typescript
private async parseMergeForward(
  messageId: string, groupFolder: string, depth?: number
): Promise<{ text: string; imagePaths: string[] }>
```

关键点：
- 调 `GET /im/v1/messages/{message_id}` 获取 items
- 需要用飞书 SDK 或 fetch + tenant_access_token
- 递归解析子消息（text/image/post/merge_forward）
- 安全限制常量：MAX_MERGE_TEXT_LEN, MAX_MERGE_IMAGES, MAX_MERGE_DEPTH

在 handleMessage 中增加 merge_forward 分支。

## Task 4: Post 图片提取增强
**File:** `src/channels/feishu.ts`  
**Requirements:** R3.1-R3.3

修改 `extractPostText` → `extractPostContent`，返回 `{ text: string, imageKeys: string[] }`：
- 遍历 paragraph elements，遇到 `tag === 'img'` 时收集 image_key
- 调 downloadImage 下载每张图
- 在文本中插入 `[图片: path]` 标记

## Task 5: 发送图片
**File:** `src/channels/feishu.ts`
**Requirements:** R4.1-R4.4

新增 `sendImage` 方法：
```typescript
async sendImage(jid: string, imagePath: string): Promise<void> {
  // 1. 读取图片文件（从宿主机路径）
  // 2. POST /im/v1/images 上传获取 image_key
  // 3. POST /im/v1/messages 发送 image 消息
}
```

在 sendMessage 中检测：如果文本匹配 `![...](path)` 或 `[image: path]` 模式，提取路径调 sendImage。

## Task 6: 测试
**File:** `src/channels/feishu.test.ts`

- 测试 extractPostContent 对含图片 post 的解析
- 测试 merge_forward 文本拼接和安全限制
- 测试 sendMessage 对图片路径的检测

## 执行顺序
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

全部完成后：`npm run build && npm run test` 必须通过。
