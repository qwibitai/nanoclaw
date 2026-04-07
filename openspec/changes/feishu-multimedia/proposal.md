## Why

NanoClaw 飞书 Channel 当前只能收发文本和富文本（post），用户发的图片、合并转发消息被直接丢弃。Agent 也无法发送图片到飞书。这严重限制了飞书场景下的交互能力。

## What Changes

- 接收图片消息：下载图片到 group 目录，文本中注明路径，Agent 可读取图片
- 接收合并转发（merge_forward）：调飞书 API 获取子消息，提取文本 + 图片
- 发送图片：Agent 输出包含图片路径时，上传到飞书并发送 image 类型消息
- 富文本（post）中的图片提取

## Capabilities

### New Capabilities
- `feishu-image-recv`: 接收飞书图片消息，下载保存，传给 Agent
- `feishu-merge-forward`: 解析合并转发消息，提取子消息文本和图片
- `feishu-image-send`: Agent 发送图片到飞书群

### Modified Capabilities
- （无已有 spec 需要修改）

## Impact

- **src/channels/feishu.ts**: handleMessage 增加 image / merge_forward 处理，sendMessage 增加图片发送
- **飞书 API**: 需要调用 `GET /im/v1/messages/:id`（获取合并转发子消息）、`GET /im/v1/messages/:id/resources/:file_key`（下载图片）、`POST /im/v1/images`（上传图片）
- **容器内**: 图片文件通过 group 目录挂载传递给 Agent
