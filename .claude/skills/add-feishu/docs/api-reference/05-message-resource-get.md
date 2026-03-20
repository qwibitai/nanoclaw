# 获取消息中的资源文件

获取指定消息内包含的资源文件，包括音频、视频、图片和文件。成功调用后，返回二进制文件流下载文件。

## 前提条件

- 应用需要开启[机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。
- 机器人和待操作的消息需要在同一会话内。

## 使用限制
- 仅支持下载 100 MB 以内的资源文件。
- 暂不支持获取表情包资源。
- 暂不支持获取合并转发消息中的子消息、卡片消息中的资源文件。如果请求时传入了合并转发消息或子消息的 ID、卡片消息 ID，则会返回错误码 234043。
- 不支持在当前接口内调整文件格式，你可以获取资源文件后，在本地自行调整。

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/im/v1/messages/:message_id/resources/:file_key
HTTP Method | GET
接口频率限制 | [1000 次/分钟、50 次/秒](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
支持的应用类型 | Custom App、Store App
权限要求<br>**调用该 API 所需的权限。开启其中任意一项权限即可调用**<br>开启任一权限即可 | 获取与发送单聊、群组消息(im:message)<br>获取单聊、群组消息(im:message:readonly)<br>获取单聊、群组的历史消息(im:message.history:readonly)

### 请求头

名称 | 类型 | 必填 | 描述
---|---|---|---
Authorization | string | 是 | `tenant_access_token`<br>**值格式**："Bearer `access_token`"<br>**示例值**："Bearer t-7f1bcd13fc57d46bac21793a18e560"<br>[了解更多：如何选择与获取 access token](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use)

### 路径参数

名称 | 类型 | 描述
---|---|---
message_id | string | 待查询的消息 ID。ID 获取方式：<br>- 调用[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)接口后，从响应结果的 `message_id` 参数获取。<br>- 监听[接收消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)事件，当触发该事件后可以从事件体内获取消息的 `message_id`。<br>- 调用[获取会话历史消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)接口，从响应结果的 `message_id` 参数获取。<br>**示例值**："om_dc13264520392913993dd051dba21dcf"
file_key | string | 待查询资源的 Key。你可以调用[获取指定消息的内容](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/get)接口，通过消息 ID 获取消息内容中的资源 Key。<br>**注意**：路径参数 `file_key` 和 `message_id` 需要匹配。<br>**示例值**："file_456a92d6-c6ea-4de4-ac3f-7afcf44ac78g"

### 查询参数

名称 | 类型 | 必填 | 描述
---|---|---|---
type | string | 是 | 资源类型<br>**可选值有：**<br>- `image`：对应消息中的图片或富文本消息中的图片。<br>- `file`：对应消息中的文件、音频、视频（表情包除外）。<br>**示例值**：image

## 响应
文件类型可通过响应头（Response Header）中的 `Content-Type` 字段获取。

HTTP状态码为 200 时，表示成功

返回文件二进制流

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 230110 | Action unavailable as the message has been deleted. | 消息已删除，无法执行操作。
400 | 234001 | Invalid request param. | 请求参数无效。请参考文档参数描述，检查请求参数是否填写正确。
401 | 234002 | Unauthorized. | 鉴权失败，请咨询[技术支持](https://applink.feishu.cn/TLJpeNdW)。
400 | 234003 | File not in message. | 该资源不属于当前消息。请检查消息 ID 和资源 Key，两者必须相匹配。
400 | 234004 | App not in chat. | 应用不在消息所在的群组中。你需要将应用机器人添加到当前消息所在群组中，或者修改正确的消息 ID。
400 | 234009 | Lack of necessary permissions. | 暂不支持在外部群中进行本操作。
400 | 234019 | scope CheckAppTenant fail. | 未获取到应用的权限信息，请重试。
400 | 234037 | Downloaded file size exceeds limit. | 下载的资源大小不允许超过 100 MB。
400 | 234038 | Do not allow downloading of message resources in restricted mode. | 不能下载保密消息中的资源文件，请检查消息是否已被设置为保密，或群组开启了防泄密模式。
400 | 234040 | The message is invisible to the operator. | 该消息对当前操作者不可见，请联系群主或群管理员检查群设置中是否关闭了 **新成员可查看历史消息**。
400 | 234041 | Tenant master key has been deleted, please contact the tenant administrator. | 租户加密密钥被删除，无法操作加密数据，可联系企业管理员排查问题。
400 | 234042 | Hybrid deployment tenant storage error, such as full storage space, please contact tenant administrator. | 请求出现混部租户存储错误，如存储空间已满等，请联系企业的管理员或技术支持。
400 | 234043 | Unsupported message type. | 不支持的消息类型，如合并转发消息（包括子消息）、消息卡片。

更多错误码信息，参见[通用错误码](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)。
