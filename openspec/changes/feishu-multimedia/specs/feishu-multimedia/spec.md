# feishu-multimedia

## Requirements

### R1: 接收图片消息
- R1.1: handleMessage 识别 `message_type === 'image'`
- R1.2: 从 content JSON 提取 `image_key`
- R1.3: 调用 `GET /im/v1/messages/{msg_id}/resources/{image_key}?type=image`（用 tenant_access_token）下载图片二进制
- R1.4: 保存到 `groups/{folder}/images/{msg_id}_{image_key}.jpg`（自动创建 images 目录）
- R1.5: 消息文本设为 `[图片: /workspace/group/images/{filename}]`，让 Agent 知道图片路径
- R1.6: 图片大小限制 20MB，超限跳过并记录 warn 日志

### R2: 接收合并转发消息
- R2.1: handleMessage 识别 `message_type === 'merge_forward'`
- R2.2: 调用 `GET /im/v1/messages/{message_id}`（注意不是 content，是消息详情 API）获取 items 子消息列表
- R2.3: 遍历 items，对每个子消息按 msg_type 提取内容：
  - text → 提取文本
  - image → 下载图片 + 返回路径标记
  - post → 提取文本 + 图片
  - merge_forward → 递归解析（最多嵌套 1 层）
- R2.4: 拼接格式 `[转发消息]\n[sender]: text\n[sender]: text\n...`
- R2.5: 安全限制：MAX_MERGE_TEXT_LEN=8000, MAX_MERGE_IMAGES=5, MAX_MERGE_DEPTH=1
- R2.6: 超限截断并附加 `[...还有 N 条消息已省略]`

### R3: 富文本（post）图片提取
- R3.1: 现有 extractPostText 增加 image_key 提取
- R3.2: post 中 `{"tag":"img","image_key":"..."}` 元素 → 下载图片 + 返回路径
- R3.3: 图片在文本中标记为 `[图片: path]`

### R4: 发送图片
- R4.1: sendMessage 检测到文本中包含本地图片路径（如 `/workspace/group/*.png` 或 `[image: path]`）
- R4.2: 读取图片文件 → `POST /im/v1/images`（form-data: image_type=message_type, image=binary）获取 image_key
- R4.3: `POST /im/v1/messages` 发送 `msg_type=image, content={"image_key":"..."}` 
- R4.4: 如果上传失败，降级为发文本 `[图片发送失败: path]`

## Acceptance Criteria

1. 用户在飞书发一张图片 → Agent 能在容器内 Read 这张图片
2. 用户发合并转发 → Agent 收到完整子消息文本
3. Agent 回复带图片路径 → 飞书群里显示图片
4. 图片下载/上传失败时不崩溃，降级处理

## Reference

- Nine 实现: `~/AI_Workspace/nine/server/backend/app/feishu/adapter.py`（Python 版，完整实现可参考）
- 飞书 API 文档: https://open.feishu.cn/document/server-docs/im-v1/message/get
