## Architecture

### 接收图片

```
飞书用户发图片 → WS 事件 msg_type=image → handleMessage
  → content: {"image_key": "img_xxx"}
  → 调 GET /im/v1/messages/{msg_id}/resources/{image_key}?type=image 下载
  → 保存到 groups/{folder}/images/{msg_id}.jpg
  → 文本内容设为 "[图片: /workspace/group/images/{msg_id}.jpg]"
  → Agent 在容器内可以 Read 这个图片文件
```

### 接收合并转发

参考 Nine adapter.py 的 `_parse_merge_forward` 实现：

```
飞书用户发合并转发 → WS 事件 msg_type=merge_forward → handleMessage
  → 调 GET /im/v1/messages/{message_id} 获取子消息列表
  → 遍历 items，对每个子消息按 msg_type 递归 extract：
    - text → 提取文本
    - image → 下载图片 + 记录路径
    - post → 提取文本 + 图片
    - merge_forward → 递归（最多 1 层）
  → 拼接为 "[转发消息]\n[sender1]: text1\n[sender2]: text2\n..."
  → 图片同样保存到 group/images/
```

### 发送图片

```
Agent 回复包含图片路径（如 /workspace/group/screenshot.png）
  → container-runner 的 onOutput 检测到路径
  → 读取文件 → POST /im/v1/images 上传获取 image_key
  → POST /im/v1/messages 发送 msg_type=image
```

或者更简单：Agent 通过 MCP `send_message` 工具发送，传 image_path 参数。

### 安全限制（参考 Nine）

```typescript
const MAX_MERGE_TEXT_LEN = 8000;  // 合并转发文本最大字符数
const MAX_MERGE_IMAGES = 5;       // 最多提取图片数
const MAX_MERGE_DEPTH = 1;        // 嵌套深度
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 单张图片最大 20MB
```

## Data Model

无新表。图片存为文件在 `groups/{folder}/images/` 目录。

## API / Interface

### 飞书 API 调用

| API | 用途 |
|-----|------|
| `GET /im/v1/messages/{msg_id}/resources/{file_key}?type=image` | 下载消息图片 |
| `GET /im/v1/messages/{msg_id}` | 获取合并转发子消息 |
| `POST /im/v1/images` | 上传图片获取 image_key |
| `POST /im/v1/messages` + `msg_type=image` | 发送图片消息 |

### 内部函数

```typescript
// feishu.ts 新增
private async downloadImage(messageId: string, imageKey: string, groupFolder: string): Promise<string>; // 返回本地路径
private async parseMessageContent(message: FeishuMessage): Promise<{ text: string; imagePaths: string[] }>;
private async parseMergeForward(messageId: string, groupFolder: string, depth?: number): Promise<{ text: string; imagePaths: string[] }>;
async sendImage(jid: string, imagePath: string): Promise<void>;
```

## Risks

1. 图片下载需要 tenant_access_token（已有）
2. 合并转发 API 可能返回大量子消息 → 用 MAX_MERGE_TEXT_LEN 限制
3. 图片文件占磁盘空间 → 考虑定期清理或限制总量
