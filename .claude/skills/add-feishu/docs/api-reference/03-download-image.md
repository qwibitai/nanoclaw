# 下载图片

通过已上传图片的 Key 值下载图片。

## 前提条件

应用需要开启[机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。

## 使用限制

- 只能下载由当前机器人上传的图片，且上传时图片类型为 **用于发送消息**。**用于设置头像** 的图片暂不支持下载。
- 该接口仅适用于通过图片的 Key 下载图片。如果你需要下载用户发送消息内的资源文件，可使用[获取消息中的资源文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get)接口。

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/im/v1/images/:image_key
HTTP Method | GET
接口频率限制 | [1000 次/分钟、50 次/秒](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
支持的应用类型 | Custom App、Store App
权限要求<br>**调用该 API 所需的权限。开启其中任意一项权限即可调用** | 无

### 请求头

名称 | 类型 | 必填 | 描述
---|---|---|---
Authorization | string | 是 | `tenant_access_token`<br>**值格式**："Bearer `access_token`"<br>**示例值**："Bearer t-7f1bcd13fc57d46bac21793a18e560"<br>[了解更多：如何选择与获取 access token](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use)

### 路径参数

名称 | 类型 | 描述
---|---|---
image_key | string | 图片的 Key，通过[上传图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create)接口上传图片后，在返回结果中获取。<br>**示例值**："img_8d5181ca-0aed-40f0-b0d1-b1452132afbg"

## 响应

HTTP状态码为 200 时，表示成功

返回文件二进制流

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 234001 | Invalid request param. | 请求参数无效，请根据接口文档描述检查请求参数是否正确。
401 | 234002 | Unauthorized. | 接口鉴权失败，请咨询[技术支持](https://applink.feishu.cn/TLJpeNdW)。
400 | 234005 | Image has been deleted | 资源不存在。请检查传入的资源信息是否正确。
400 | 234007 | App does not enable bot feature. | 应用没有启用机器人能力。启用方式参见[如何启用机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。
400 | 234008 | The app is not the resource sender | 当前应用不是资源的所有者，无法进行操作。
400 | 234041 | Tenant master key has been deleted, please contact the tenant administrator. | 租户加密密钥被删除，被加密的数据无法操作，请联系租户管理员。
400 | 234042 | Hybrid deployment tenant storage error, such as full storage space, please contact tenant administrator. | 租户的自定义存储发生错误，如存储空间已满等。请联系租户管理员或[技术支持](https://applink.feishu.cn/TLJpeNdW)。

更多错误码信息，参见[通用错误码](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)。
